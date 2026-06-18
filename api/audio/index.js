// GET /api/audio/<id>[.mp3] — streams a cached radio segment from blob.
// Segments are immutable (their name is a content hash), so we serve them with
// a long immutable Cache-Control. The CDN/browser holds them after first play.

const store = require('../shared/store');

module.exports = async function (context, req) {
  let id = (context.bindingData && context.bindingData.id) || '';
  id = String(id).replace(/\.mp3$/i, '').replace(/[^a-z0-9_-]/gi, '');
  if (!id) { context.res = { status: 400, body: 'bad id' }; return; }

  try {
    const bytes = await store.downloadAudio(id);
    if (!bytes) { context.res = { status: 404, body: 'not found' }; return; }
    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'public, max-age=2592000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
      },
      isRaw: true,
      body: bytes,
    };
  } catch (e) {
    context.log.error('[audio] ' + (e && e.message));
    context.res = { status: 503, body: 'audio unavailable' };
  }
};
