// GET /api/playlist — the current on-air program manifest.
// Served from blob (radio/program.json). If it has never been built (fresh
// deploy), build it once on the first request so the station is never empty.

const store = require('../shared/store');

let building = null; // de-dupe concurrent cold-start builds within an instance

module.exports = async function (context, req) {
  try {
    let program = await store.readProgram();
    if (!program || !Array.isArray(program.segments) || !program.segments.length) {
      const { buildProgram } = require('../shared/program');
      if (!building) building = buildProgram({ log: (m) => context.log('[playlist build] ' + m) }).finally(() => { building = null; });
      program = await building;
    }
    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(program),
    };
  } catch (e) {
    context.log.error('[playlist] ' + (e && e.message));
    context.res = {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'program unavailable', detail: String(e && e.message || e) }),
    };
  }
};
