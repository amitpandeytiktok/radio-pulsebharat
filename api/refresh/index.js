// GET|POST /api/refresh?key=<REFRESH_KEY> — rebuild the on-air program from the
// latest tech/AI feed. Guarded by a shared secret so only the scheduled GitHub
// Action (or the operator) can trigger a (paid) synth run.

const { buildProgram } = require('../shared/program');

module.exports = async function (context, req) {
  const expected = process.env.REFRESH_KEY;
  const given = (req.query && req.query.key) || (req.headers && req.headers['x-refresh-key']) || '';
  if (!expected || given !== expected) {
    context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized' }) };
    return;
  }
  const started = Date.now();
  try {
    const program = await buildProgram({ log: (m) => context.log('[refresh] ' + m) });
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        segments: program.count,
        totalDurationMs: program.totalDurationMs,
        newsUpdatedAt: program.newsUpdatedAt,
        builtInMs: Date.now() - started,
      }),
    };
  } catch (e) {
    context.log.error('[refresh] ' + (e && e.message));
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) };
  }
};
