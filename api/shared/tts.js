// Hindi text-to-speech for Pulse Bharat Radio.
//
// Synthesises a single radio segment (Devanagari Hindi with English proper
// nouns kept inline) to a CBR MP3 via the Azure Speech REST API, then caches it
// in blob under <prefix>audio/<hash>.mp3. The clip name is a content hash of
// voice+text, so:
//   - identical text on the next refresh is a no-op (skips the paid synth call),
//   - the exact duration is recoverable from the CBR byte size (no decoder).
//
// Env:
//   SPEECH_KEY     — Azure Cognitive Services Speech key
//   SPEECH_REGION  — e.g. eastus2 (supports hi-IN neural voices)
//   RADIO_VOICE    — optional; default hi-IN-MadhurNeural (bold male news anchor)
//   RADIO_RATE     — optional prosody rate; default +6% (radio energy)

const https = require('https');
const crypto = require('crypto');
const { audioInfo, uploadAudio } = require('./store');

const VOICE_DEFAULT = process.env.RADIO_VOICE || 'hi-IN-MadhurNeural';
const RATE_DEFAULT = process.env.RADIO_RATE || '+6%';
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION || 'eastus2';
// 48 kbit/s constant-bitrate mono MP3 → duration(ms) ≈ bytes / 6.
const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const CBR_BYTES_PER_MS = 6;

// The F0 free tier rate-limits synthesis (~20 calls/60s) and the SWA gateway
// caps a request at ~45s, so the program builder bounds how many NEW clips it
// voices per build. Here we only lightly smooth bursts (serialise + a small gap)
// and retry a throttled (429) call with short backoff. Cached refreshes never
// reach the REST call, so they stay fast.
const MIN_SYNTH_INTERVAL_MS = parseInt(process.env.TTS_MIN_INTERVAL_MS || '250', 10);
const MAX_SYNTH_RETRIES = parseInt(process.env.TTS_MAX_RETRIES || '3', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _synthChain = Promise.resolve();
let _lastSynthAt = 0;

function ssmlEscape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function buildSsml(text, voice, rate, tailMs) {
  const v = voice || VOICE_DEFAULT;
  const r = rate || RATE_DEFAULT;
  const tail = Math.max(0, (tailMs == null ? 350 : tailMs) | 0);
  const body = ssmlEscape(text);
  const inner = (r && r !== '0%') ? `<prosody rate="${r}">${body}</prosody>` : body;
  const brk = tail > 0 ? `<break time="${tail}ms"/>` : '';
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="hi-IN">` +
    `<voice name="${v}">${inner}${brk}</voice></speak>`;
}

function clipName(text, voice, tailMs) {
  const v = voice || VOICE_DEFAULT;
  const tail = (tailMs == null ? 350 : tailMs) | 0;
  const tailPart = tail === 350 ? '' : `|t${tail}`;
  return crypto.createHash('sha1').update(`${v}|${RATE_DEFAULT}|${text}${tailPart}`).digest('hex').slice(0, 24);
}

function durationFromBytes(bytes) {
  return Math.max(900, Math.round(bytes / CBR_BYTES_PER_MS));
}

// Synthesise SSML → MP3 bytes via Azure Speech REST.
function speakSsml(ssml) {
  return new Promise((resolve, reject) => {
    if (!SPEECH_KEY) return reject(new Error('SPEECH_KEY missing'));
    const data = Buffer.from(ssml, 'utf8');
    const req = https.request({
      hostname: `${SPEECH_REGION}.tts.speech.microsoft.com`,
      path: '/cognitiveservices/v1',
      method: 'POST',
      timeout: 25000,
      headers: {
        'Ocp-Apim-Subscription-Key': SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AUDIO_FORMAT,
        'User-Agent': 'PulseBharatRadioTTS/1.0',
        'Content-Length': data.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(Buffer.concat(chunks));
        const err = new Error(`tts HTTP ${res.statusCode} ${Buffer.concat(chunks).slice(0, 200).toString('utf8')}`);
        err.status = res.statusCode;
        const ra = parseInt(res.headers['retry-after'] || '', 10);
        if (ra > 0) err.retryAfterMs = ra * 1000;
        reject(err);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('tts timeout')));
    req.write(data); req.end();
  });
}

// Retry a throttled (429) synth with exponential backoff, honouring Retry-After.
async function speakWithRetry(ssml) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await speakSsml(ssml);
    } catch (e) {
      const throttled = e && (e.status === 429 || /\b429\b|quota|throttl/i.test(e.message || ''));
      if (!throttled || attempt >= MAX_SYNTH_RETRIES) throw e;
      const backoff = Math.max(e.retryAfterMs || 0, Math.min(8000, 1500 * Math.pow(2, attempt))) + Math.floor(Math.random() * 400);
      await sleep(backoff);
    }
  }
}

// Serialise + pace synth calls across the whole process so non-cached bursts
// stay under the F0 rate limit.
function pacedSpeak(ssml) {
  const run = _synthChain.then(async () => {
    const wait = MIN_SYNTH_INTERVAL_MS - (Date.now() - _lastSynthAt);
    if (wait > 0) await sleep(wait);
    try { return await speakWithRetry(ssml); }
    finally { _lastSynthAt = Date.now(); }
  });
  _synthChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Synthesise (or reuse cached) audio for one segment of Hindi text.
 * Returns { audio, durationMs, bytes, voice, cached, name } or throws.
 */
async function speak(text, opts = {}) {
  const voice = opts.voice || VOICE_DEFAULT;
  const tailMs = opts.tailMs;
  const clean = String(text || '').trim();
  if (!clean) throw new Error('empty tts text');
  const name = clipName(clean, voice, tailMs);

  const info = await audioInfo(name);
  if (info.exists && info.size > 0) {
    return { audio: `/api/audio/${name}.mp3`, durationMs: durationFromBytes(info.size), bytes: info.size, voice, cached: true, name };
  }

  const mp3 = await pacedSpeak(buildSsml(clean, voice, opts.rate, tailMs));
  const url = await uploadAudio(name, mp3);
  return { audio: url, durationMs: durationFromBytes(mp3.length), bytes: mp3.length, voice, cached: false, name };
}

module.exports = { speak, buildSsml, clipName, durationFromBytes, VOICE_DEFAULT };
