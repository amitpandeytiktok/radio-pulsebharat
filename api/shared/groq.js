// Groq chat completions — free, OpenAI-compatible inference. Primary LLM for the
// Hindi-RJ script writer. Every caller falls back to a templated line on any
// error, so the radio degrades gracefully rather than going silent.
//
// Env: GROQ_API_KEY (https://console.groq.com/keys)
//   GROQ_MODEL       quality tasks  default llama-3.3-70b-versatile
//   GROQ_MODEL_FAST  cheap/fast     default llama-3.1-8b-instant

const https = require('https');

const QUALITY_MODEL = () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const FAST_MODEL = () => process.env.GROQ_MODEL_FAST || 'llama-3.1-8b-instant';
const TIMEOUT_MS = 25_000;

function hasGroq() {
  return !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
}

function groqChat({ system, user, model, max_tokens = 320, temperature = 0.7, timeout = TIMEOUT_MS }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return Promise.reject(new Error('GROQ_API_KEY missing'));
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = Buffer.from(JSON.stringify({
    model: model || QUALITY_MODEL(),
    messages,
    max_tokens,
    temperature,
  }));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`groq HTTP ${res.statusCode} ${buf.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(buf);
          const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          resolve(String(text));
        } catch { reject(new Error('non-JSON groq response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('groq timeout')));
    req.write(body);
    req.end();
  });
}

module.exports = { groqChat, hasGroq, QUALITY_MODEL, FAST_MODEL };
