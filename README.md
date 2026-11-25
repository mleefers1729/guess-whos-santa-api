# Guess Who's Santa API

Node.js API foundation for a React party game: hosts invite friends, players
submit portraits, a Santa disguise hides everything except their eyes, and the
party guesses who each Santa is.

## Local development

Requires Node.js **22.9+** and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

The API listens on `http://127.0.0.1:3000`. Use `npm start` without watch mode
and `npm test` for the HTTP integration tests (Node's built-in test runner).
There is no compilation or lint step.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; deliberately local-only by default |
| `PORT` | `3000` | HTTP port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Exact React origin allowed by CORS (no trailing slash) |
| `UPLOAD_DIR` | `./uploads` | Private photo directory, relative to the process working directory |
| `MAX_UPLOAD_BYTES` | `10485760` | Maximum input photo size (10 MiB) |

Keep `.env` and uploaded photos out of version control. `.env.example` contains
only non-secret local defaults.

## API

### `GET /health`

Returns `200` with:

```json
{ "status": "ok", "name": "guess-whos-santa-api" }
```

### `POST /api/uploads`

Send `multipart/form-data` with exactly one file named `photo` and no other fields:

```sh
curl -F 'photo=@portrait.jpg' http://127.0.0.1:3000/api/uploads
```

The response is `201` with `{ "id", "contentType", "width", "height", "size" }`.
`id` is a generated UUID, `contentType` is `image/webp`, dimensions are pixels,
and `size` is the stored file's byte count. The original filename is never used.

Example from React (do not set `Content-Type` yourself; the browser adds the boundary):

```js
const body = new FormData();
body.append('photo', file);
const response = await fetch('http://127.0.0.1:3000/api/uploads', {
  method: 'POST',
  body,
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
```

JPEG, PNG, and WebP files are checked against their decoded format; corrupt,
animated, or greater-than-20-megapixel images are rejected. Images are
auto-oriented, resized to fit 2048 × 2048 without enlargement, stripped of
metadata (including EXIF/GPS), and re-encoded as WebP. Incoming files spool to
disk rather than buffering the full upload in memory. Temporary inputs are
removed after processing or rejected multipart requests.

Errors use `{ "error": "message" }`: `400` for missing/unexpected fields, `413`
for oversized input, `415` for unsupported MIME types, `422` for invalid image
content, and `429` after 20 upload attempts per IP per 15 minutes. Internal
errors return a generic `500` message. Unknown routes return JSON `404` errors.

## Game and deployment boundaries

This is a local-development foundation, **not a complete or publicly deployable
game**. Photos remain private on disk; no static upload directory or download
endpoint is exposed. Normalization is **not** Santa masking: the saved image
still shows the player's face. Upload IDs are identifiers, not authorization.
The API currently has no accounts, party membership checks, database, or
automatic photo expiration.

Next game features:

- Persist hosts, parties, expiring invitations, and player memberships.
- Authenticate players and associate uploads with their party and owner.
- Add the Santa overlay/eye-window workflow; publish only approved masked
  variants to party members, never the source portrait.
- Add submission/guessing/reveal phases, one guess per player/photo, and scoring;
  keep player identities and answer keys private until reveal.

Before any public deployment:

- Add authentication, party-level authorization, and upload quotas. CORS is
  browser policy, **not** access control, and the upload endpoint is unauthenticated.
- Use private object storage with lifecycle deletion and authorized delivery of
  masked images for multiple instances and many uploads. Local disk is only a
  single-instance development store and grows until explicitly cleaned.
- Define photo consent/retention rules and remove abandoned photos and stale
  `.incoming` files after crashes.
- Terminate HTTPS at a reverse proxy, bound request sizes/timeouts and processing
  concurrency, and configure trusted proxy hops explicitly. The default limiter
  uses process-local memory and the direct peer IP; use a shared limiter store
  for multiple instances.
