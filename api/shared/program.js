// Program builder for Pulse Bharat Radio.
//
// Pulls the live ranked all-India news feed from Pulse Bharat, selects the top
// stories, writes a Hindi-RJ line for each (cached per story so refreshes stay
// cheap), synthesises audio, and assembles the on-air playlist manifest
// (<prefix>program.json):
//
//   ident → [segue] story → … → sign-off   (the player loops the whole thing)
//
// Env:
//   NEWS_API       feed URL; default https://pulsebharat.com/api/news
//   RADIO_STORIES  how many stories per program; default 12

const store = require('./store');
const tts = require('./tts');
const { rjLine, sanitize, BUMPERS, CAT_LEAD, pick } = require('./script');

const NEWS_API = process.env.NEWS_API || 'https://pulsebharat.com/api/news';
const N_STORIES = Math.max(4, Math.min(24, parseInt(process.env.RADIO_STORIES || '12', 10)));
const LINES_BLOB = store.PREFIX + 'lines.json';
const LINE_TTL_MS = 24 * 60 * 60 * 1000;
const STATION = 'Pulse Bharat Radio';
const TAGLINE = 'भारत की धड़कन · हर बड़ी खबर · हिंदी में, चौबीसों घंटे';

async function fetchFeed() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(NEWS_API, { signal: ctrl.signal, headers: { 'User-Agent': 'PulseBharatRadio/1.0' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Merge good/bad/ugly into one pool, keep cluster primaries, dedupe by link,
// rank by how widely the event is covered and how fresh it is, take the top N.
function selectStories(feed) {
  const pool = [];
  for (const cat of ['good', 'bad', 'ugly']) {
    for (const s of (feed[cat] || [])) {
      if (s && s.isPrimary === false) continue;
      pool.push({ ...s, cat });
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const s of pool) {
    const k = s.link || s.slug || s.title;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  uniq.sort((a, b) => {
    const sc = (b.sourceCount || 1) - (a.sourceCount || 1);
    if (sc) return sc;
    return (b.ts || 0) - (a.ts || 0);
  });
  return uniq.slice(0, N_STORIES);
}

// Per-story line cache keeps the spoken text stable across refreshes, which in
// turn keeps the audio hash stable (cache hit, no re-synth, fewer LLM calls).
async function loadLines() {
  const j = await store.readJson(LINES_BLOB);
  return (j && typeof j === 'object') ? j : {};
}

async function lineFor(story, lines) {
  const key = story.link || story.slug || story.title;
  const hit = key && lines[key];
  if (hit && hit.text && (Date.now() - (hit.ts || 0) < LINE_TTL_MS)) return hit.text;
  const text = await rjLine(story);
  if (key) lines[key] = { text, ts: Date.now() };
  return text;
}

function leadIn(story) {
  return CAT_LEAD[story.cat] || '';
}

// Build + persist the full program. Returns the manifest.
async function buildProgram(opts = {}) {
  const log = opts.log || (() => {});
  const feed = await fetchFeed();
  const stories = selectStories(feed);
  log(`selected ${stories.length} stories (news @ ${feed.updatedAt || '?'})`);
  if (!stories.length) throw new Error('no stories from feed');

  const lines = await loadLines();
  const hourSeed = Math.floor(Date.now() / 3600000);
  const segments = [];

  // Opening station ident.
  segments.push(await voiceSeg('ident', pick(BUMPERS.ident, hourSeed), { title: STATION }));

  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    if (i > 0 && i % 3 === 0) {
      segments.push(await voiceSeg('segue', pick(BUMPERS.segue, hourSeed + i), { title: STATION }));
    }
    const spoken = sanitize(leadIn(s) + (await lineFor(s, lines)));
    const seg = await voiceSeg('story', spoken, {
      cat: s.cat,
      title: s.title || s.titleEn || '',
      titleHi: s.titleHi || '',
      source: s.source || '',
      link: s.link || '',
      beat: s.beat || '',
    });
    log(`  [${i + 1}/${stories.length}] ${seg.cached ? 'cached' : 'synth '} ${Math.round(seg.durationMs / 1000)}s · ${(s.title || '').slice(0, 60)}`);
    segments.push(seg);
  }

  // Sign-off, then the player loops back to the ident.
  segments.push(await voiceSeg('signoff', pick(BUMPERS.signoff, hourSeed), { title: STATION }));

  // Persist the (possibly refreshed) line cache, pruned to current links.
  const keep = {};
  for (const s of stories) {
    const k = s.link || s.slug || s.title;
    if (k && lines[k]) keep[k] = lines[k];
  }
  try { await store.writeJson(LINES_BLOB, keep); } catch (e) { log('lines cache write skipped: ' + e.message); }

  const program = {
    station: STATION,
    tagline: TAGLINE,
    voice: tts.VOICE_DEFAULT,
    updatedAt: new Date().toISOString(),
    source: NEWS_API,
    newsUpdatedAt: feed.updatedAt || null,
    count: segments.length,
    totalDurationMs: segments.reduce((a, s) => a + (s.durationMs || 0), 0),
    segments,
  };
  await store.writeProgram(program);
  log(`program written: ${segments.length} segments · ${Math.round(program.totalDurationMs / 1000)}s total`);
  return program;
}

// Synthesise one segment and shape its manifest entry.
async function voiceSeg(kind, text, meta = {}) {
  const out = await tts.speak(text);
  return {
    id: out.name,
    kind,
    cat: meta.cat || null,
    title: meta.title || '',
    titleHi: meta.titleHi || '',
    source: meta.source || '',
    link: meta.link || '',
    beat: meta.beat || '',
    text,
    audio: out.audio,
    durationMs: out.durationMs,
    cached: out.cached,
  };
}

module.exports = { buildProgram, selectStories, fetchFeed, N_STORIES };
