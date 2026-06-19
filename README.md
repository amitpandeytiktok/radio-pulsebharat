# Pulse Bharat Radio — radio.pulsebharat.com

A 24×7 Hindi news radio. One bold anchor voice narrates the latest all-India
stories in natural Hindi (place names and proper nouns kept natural), looping
forever — a single continuous stream of the day's biggest news, **Hindi first**.

It reuses the Pulse Bharat newsroom: the same ranked, clustered, multi-source
feed (`good` / `bad` / `ugly`), turned into on-air radio.

## How it works

1. **Feed** — pulls the live ranked news feed from `https://pulsebharat.com/api/news`,
   merges the clusters, dedupes, and ranks by coverage + freshness.
2. **Script** — Groq writes a 2–3 sentence Hindi news-anchor line per story
   (fallback = a clean templated line from the story's own Hindi title).
3. **Voice** — Azure Speech Neural TTS (`hi-IN-MadhurNeural`) renders each segment
   to a CBR MP3, hash-cached in blob so unchanged stories never re-synthesise.
4. **Program** — `ident → story → …`, persisted as a filler-free manifest.
5. **Player** — a continuous looping web player (ON AIR indicator, now-playing
   console, up-next queue, read-the-story links), Hindi-first UI.
6. **Refresh** — a GitHub Action cron (~every 3h) rebuilds the program from the
   latest feed; cached audio keeps each run comfortably inside the free tier.

## Endpoints

- `GET /api/playlist` → program manifest (built on first miss)
- `GET /api/audio/{id}` → stream a segment MP3
- `GET|POST /api/refresh?key=REFRESH_KEY` → rebuild the program

## Deploy

Azure Static Web App **`radio-pulsebharat`** (Free, `lms-rg`), custom domain
`radio.pulsebharat.com` (Cloudflare CNAME → SWA host).

| Secret | Purpose |
| --- | --- |
| `AZURE_SWA_DEPLOY_TOKEN` | Deployment token for the `radio-pulsebharat` SWA |
| `REFRESH_KEY` | Guards `/api/refresh` |

| App setting | Notes |
| --- | --- |
| `BLOB_CONN` | Azure Storage connection string (shared `feed` container) |
| `BLOB_PREFIX` | Blob namespace for this station; `radio-pb/` |
| `SPEECH_KEY` / `SPEECH_REGION` | Azure Speech (F0); region `eastus2` supports `hi-IN` |
| `GROQ_API_KEY` | LLM for the anchor lines |
| `REFRESH_KEY` | Guards `/api/refresh` |
| `RADIO_VOICE` | Optional; default `hi-IN-MadhurNeural` |
| `NEWS_API` | Optional; default `https://pulsebharat.com/api/news` |
| `RADIO_STORIES` | Optional; stories per program (default 28) |
| `RADIO_MAX_NEW` | Optional; max uncached synths per refresh (default 12) |
| `RADIO_BUDGET_MS` | Optional; refresh build budget (default 36000) |

Built on the same engine as TechWave Radio and The Mudda Radio.
