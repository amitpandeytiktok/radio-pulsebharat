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

// The feed already carries the newsroom's own ranking (`rank` = how widely the
// event is covered × how fresh it is, with gossip "masala" demoted) and a
// `featured` hero — the exact ordering shown on pulsebharat.com. We mirror that
// instead of re-sorting, so the radio plays the same top stories, in the same
// order of importance, as the news page.
function rankOf(s) {
  if (typeof s.rank === 'number') return s.rank;
  // Fallback if a story somehow lacks a server rank: recompute the site's formula.
  const sc = s.sourceCount || 1;
  const hoursOld = s.ts ? (Date.now() - s.ts) / 3600000 : 48;
  return Math.log(1 + sc * 2.2) - Math.log(1 + hoursOld * 0.45) - (s.masala ? 10 : 0);
}

function storyKey(s) {
  return s.link || s.slug || s.title || null;
}

// Lead with the page's featured hero, then order strictly by the feed's `rank`,
// keeping only cluster primaries and dropping masala (the page buries it too).
function selectStories(feed) {
  const pool = [];
  if (feed.featured && feed.featured.title) {
    pool.push({ ...feed.featured, cat: feed.featured.cat || 'good' });
  }
  for (const cat of ['good', 'bad', 'ugly']) {
    for (const s of (feed[cat] || [])) {
      if (s && s.isPrimary === false) continue;
      if (s && s.masala) continue;
      pool.push({ ...s, cat });
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const s of pool) {
    const k = storyKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  const featuredKey = feed.featured ? storyKey(feed.featured) : null;
  uniq.sort((a, b) => {
    if (featuredKey) {
      if (storyKey(a) === featuredKey) return -1;
      if (storyKey(b) === featuredKey) return 1;
    }
    return rankOf(b) - rankOf(a);
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

// Build + persist the program — bounded + resumable.
//
// Two hard limits make a cold "voice everything now" build impossible: the F0
// free Speech tier rate-limits synthesis (~20 calls / 60s → 429) and the SWA
// managed-functions gateway cuts any request at ~45s. So when a reshuffle makes
// many stories new at once we can't voice them all in one request. Instead each
// run: (1) writes/refreshes a STABLE Hindi-RJ line per story and persists the
// cache even on a partial run — so the text, and therefore the audio hash, is
// identical next time; (2) voices at most `maxNew` not-yet-cached clips inside a
// time budget; (3) assembles the playlist from whatever audio is ready and skips
// stories still warming. Manual refreshes + the 3-hourly cron converge to the
// full program; clips are content-hash cached, so warm runs reassemble instantly
// and nothing is ever voiced twice.
async function buildProgram(opts = {}) {
  const log = opts.log || (() => {});
  const maxNew = Math.max(1, parseInt(opts.maxNew || process.env.RADIO_MAX_NEW || '14', 10));
  const budgetMs = Math.max(10000, parseInt(opts.budgetMs || process.env.RADIO_BUDGET_MS || '36000', 10));
  const started = Date.now();
  const overBudget = () => (Date.now() - started) > budgetMs;

  const feed = await fetchFeed();
  const stories = selectStories(feed);
  log(`selected ${stories.length} stories (news @ ${feed.updatedAt || '?'})`);
  if (!stories.length) throw new Error('no stories from feed');

  const lines = await loadLines();
  const hourSeed = Math.floor(Date.now() / 3600000);

  let made = 0;
  let budgetHit = false;

  // Voice one segment, or reuse its cached clip. Never throws and never exceeds
  // the per-run synth cap / time budget — over the limit it returns null so the
  // caller can skip the segment (a later refresh fills it in).
  async function ensureSeg(kind, text, meta = {}) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const name = tts.clipName(clean, tts.VOICE_DEFAULT);
    let cached = false;
    try {
      const info = await store.audioInfo(name);
      cached = !!(info && info.exists && info.size > 0);
    } catch (e) { /* treat as not cached */ }
    if (!cached && (made >= maxNew || overBudget())) { budgetHit = true; return null; }
    try {
      const out = await tts.speak(clean);
      if (!out.cached) made++;
      return shapeSeg(kind, out, clean, meta);
    } catch (e) {
      budgetHit = true;
      log(`  ! skipped ${kind} (${String(meta.title || '').slice(0, 40)}): ${e.message}`);
      return null;
    }
  }

  const segments = [];
  let aired = 0;
  let pending = 0;

  const ident = await ensureSeg('ident', pick(BUMPERS.ident, hourSeed), { title: STATION });
  if (ident) segments.push(ident);

  // Stage segues so we never emit one that isn't followed by a real story.
  let stagedSegue = null;
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    if (i > 0 && i % 3 === 0) stagedSegue = pick(BUMPERS.segue, hourSeed + i);
    // Always (re)generate + cache the line so the spoken text stays stable.
    const spoken = sanitize(leadIn(s) + (await lineFor(s, lines)));
    const seg = await ensureSeg('story', spoken, {
      cat: s.cat,
      title: s.title || s.titleEn || '',
      titleHi: s.titleHi || '',
      source: s.source || '',
      link: s.link || '',
      beat: s.beat || '',
    });
    if (!seg) { pending++; log(`  … warming · ${(s.title || '').slice(0, 55)}`); continue; }
    if (stagedSegue) {
      const segue = await ensureSeg('segue', stagedSegue, { title: STATION });
      if (segue) segments.push(segue);
      stagedSegue = null;
    }
    segments.push(seg);
    aired++;
    log(`  [${aired}] ${seg.cached ? 'cached' : 'synth '} ${Math.round(seg.durationMs / 1000)}s · ${(s.title || '').slice(0, 55)}`);
  }

  const signoff = await ensureSeg('signoff', pick(BUMPERS.signoff, hourSeed), { title: STATION });
  if (signoff) segments.push(signoff);

  // Persist the line cache (pruned to current stories) on every run — including
  // partial ones — so the spoken text stays stable and later refreshes converge.
  const keep = {};
  for (const s of stories) {
    const k = storyKey(s);
    if (k && lines[k]) keep[k] = lines[k];
  }
  try { await store.writeJson(LINES_BLOB, keep); } catch (e) { log('lines cache write skipped: ' + e.message); }

  if (!aired) throw new Error('no story audio ready yet (F0 warming) — refresh again shortly');

  const program = {
    station: STATION,
    tagline: TAGLINE,
    voice: tts.VOICE_DEFAULT,
    updatedAt: new Date().toISOString(),
    source: NEWS_API,
    newsUpdatedAt: feed.updatedAt || null,
    partial: pending > 0 || budgetHit,
    aired,
    pending,
    count: segments.length,
    totalDurationMs: segments.reduce((a, s) => a + (s.durationMs || 0), 0),
    segments,
  };
  await store.writeProgram(program);
  log(`program: ${segments.length} segs · ${aired} aired · ${pending} warming · ${made} new synths · ${Math.round(program.totalDurationMs / 1000)}s${program.partial ? ' (partial)' : ''}`);
  return program;
}

// Shape a manifest entry from a synth/cache result (from tts.speak()).
function shapeSeg(kind, out, text, meta = {}) {
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
