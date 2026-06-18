// Blob store for Pulse Bharat Radio. Reuses the SAME storage account + `feed`
// container as the rest of the family, but keeps every radio asset under a
// per-station prefix (default `radio-pb/`) so the stations never collide.
//
//   radio-pb/program.json        -> the current on-air playlist manifest
//   radio-pb/audio/<hash>.mp3     -> one synthesised segment (hash-cached)
//
// Env:
//   BLOB_CONN    Azure Storage connection string
//   BLOB_PREFIX  blob namespace for this station; default radio-pb/

const BLOB_CONN = process.env.BLOB_CONN;
const CONTAINER = 'feed';

const PREFIX = (process.env.BLOB_PREFIX || 'radio-pb/').replace(/\/*$/, '/');
const PROGRAM_BLOB = PREFIX + 'program.json';
const AUDIO_PREFIX = PREFIX + 'audio/';

let _container = null;
function container() {
  if (!BLOB_CONN) return null;
  if (_container) return _container;
  try {
    const { BlobServiceClient } = require('@azure/storage-blob');
    _container = BlobServiceClient.fromConnectionString(BLOB_CONN).getContainerClient(CONTAINER);
  } catch (e) {
    console.warn('[store] init failed:', e.message);
    _container = null;
  }
  return _container;
}

async function readJson(name) {
  const c = container();
  if (!c) return null;
  try {
    const buf = await c.getBlockBlobClient(name).downloadToBuffer();
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e.statusCode !== 404) console.warn(`[store] read ${name} failed:`, e.message);
    return null;
  }
}

async function writeJson(name, data) {
  const c = container();
  if (!c) throw new Error('blob container unavailable');
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  await c.getBlockBlobClient(name).upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8', blobCacheControl: 'no-cache' },
  });
}

const readProgram = () => readJson(PROGRAM_BLOB);
const writeProgram = (data) => writeJson(PROGRAM_BLOB, data);

// Does radio/audio/<name>.mp3 already exist, and how big is it? Lets the program
// builder skip re-synthesising (and re-paying for) audio whose text hasn't
// changed, while still recovering the exact CBR duration from the byte size.
async function audioInfo(name) {
  const c = container();
  if (!c) return { exists: false, size: 0 };
  try {
    const props = await c.getBlockBlobClient(AUDIO_PREFIX + name + '.mp3').getProperties();
    return { exists: true, size: props.contentLength || 0 };
  } catch (e) {
    return { exists: false, size: 0 };
  }
}

// Upload MP3 bytes to radio/audio/<name>.mp3 (private blob; streamed by /api/audio).
async function uploadAudio(name, mp3Bytes) {
  const c = container();
  if (!c) throw new Error('blob container unavailable');
  await c.getBlockBlobClient(AUDIO_PREFIX + name + '.mp3').upload(mp3Bytes, mp3Bytes.length, {
    blobHTTPHeaders: {
      blobContentType: 'audio/mpeg',
      blobCacheControl: 'public, max-age=2592000, immutable',
    },
  });
  return `/api/audio/${name}.mp3`;
}

// Stream radio/audio/<name>.mp3 back out (used by the /api/audio Function).
async function downloadAudio(name) {
  const c = container();
  if (!c) return null;
  try {
    const dl = await c.getBlockBlobClient(AUDIO_PREFIX + name + '.mp3').download();
    const chunks = [];
    for await (const chunk of dl.readableStreamBody) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.statusCode !== 404) console.warn(`[store] audio ${name} failed:`, e.message);
    return null;
  }
}

module.exports = {
  container, readJson, writeJson,
  readProgram, writeProgram,
  audioInfo, uploadAudio, downloadAudio,
  PREFIX,
};
