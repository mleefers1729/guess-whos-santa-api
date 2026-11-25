# Guess Who's Santa API

Express API for a mobile Christmas party game. Requires Node.js 24 for the
deployment image; local Node.js 22.9+ remains supported.

## Development

```sh
npm ci
cp .env.example .env
docker compose up -d db   # local PostgreSQL 17
npm run dev
```

The default server is `http://127.0.0.1:3000` (the frontend's Vite dev server
proxies `/api`). Migrations run automatically at startup. Without
`DATABASE_HOST` the API starts but party routes are disabled.

Tests use Node's test runner. Party tests need PostgreSQL and are skipped
without `TEST_DATABASE_URL`; GitHub Actions provides one:

```sh
TEST_DATABASE_URL=postgres://santa:santa-local-only@127.0.0.1:5432/santa npm test
```

## Game API

All routes are under `/api`, return `Cache-Control: no-store`, and use JSON
errors `{ "error": "message" }`. Players authenticate with
`Authorization: Bearer <token>`; the token is returned once on create/join and
only its SHA-256 hash is stored.

| Route | Who | Notes |
| --- | --- | --- |
| `POST /parties` `{name}` | anyone | Creates a party and host; returns `{code, playerId, token}` |
| `POST /parties/:code/players` `{name}` | anyone with the code | Lobby only; names unique per party (case-insensitive) |
| `GET /parties/:code` | members | Party state; supports `If-None-Match` (304) for 3 s polling |
| `PUT /parties/:code/photo` | members | Multipart `photo` + `x`, `y`, `zoom`; lobby only; replaces previous photo |
| `DELETE /parties/:code/players/:id` | host | Lobby only; deletes their photos |
| `POST /parties/:code/start` | host | Lobby → guessing; needs ≥ 2 photos |
| `PUT /parties/:code/guesses/:photoId` `{playerId}` | members | One guess per Santa (locked), no self-guess |
| `POST /parties/:code/reveal` | host | Guessing → reveal |

### Photo privacy model

- On upload the server validates the image (JPEG/PNG/WebP, ≤ 10 MiB, ≤ 20 MP,
  single frame), auto-orients it and produces two metadata-stripped WebP files:
  - **eyes**: only the pixels inside the Santa eye window (420×96), computed from
    the same geometry as the frontend SVG. This is all anyone sees before reveal.
  - **face**: the full photo (≤ 1024 px) for the reveal.
- Object keys are random UUIDs (`media/<party>/<photo>.webp`,
  `reveals/<party>/<photo>.webp`); names never appear in keys or URLs.
- Before reveal, state contains no face URLs and no Santa→player mapping (a
  player only learns which Santa is their own). Face URLs are issued only in the
  reveal phase, only to authenticated members of that party.
- Photo URLs are signed per object and expire in 10–15 minutes: CloudFront
  signed URLs in production; HMAC-signed `/api/local-media/...` URLs locally.
- Parties are inaccessible after 30 days and deleted hourly (cascading to
  players, photos and guesses); S3 lifecycle deletes objects after 30 days.
- Display names are stored in plain text in the encrypted RDS database. Hashing a
  name would not protect it (names are easy to guess) and would prevent showing
  it at the reveal; tokens are hashed instead.
- Party members can still screenshot a revealed face; no web app can prevent that.

## Hosting foundation

- `GET /health`: process liveness for the container and ALB. Returns
  `{ "status": "ok", "name": "guess-whos-santa-api" }`. Does not check PostgreSQL.
- `GET /api/health`: uncached readiness. Reports `database: "connected"` when the
  database query succeeds, `database: "not-configured"` in local development,
  or a `503` with `database: "unavailable"` on connection/query failure.
- All routes except liveness require `X-Origin-Verify` when the origin secret is
  configured. In AWS, CloudFront injects it, the ALB checks it, and Express checks
  it again. The ALB permits ingress only from the CloudFront managed prefix list.
- Production explicitly trusts two proxy hops (CloudFront then ALB). Do not use
  this trust configuration on an origin reachable through a shorter proxy path.
- Production requires HTTPS client origin, origin secret, and database settings.
  PostgreSQL uses a bounded pool and verifies TLS with the regional AWS RDS CA
  bundle downloaded during the Docker build.
- The container runs as non-root on ARM64. No writable local photo store is
  needed. ECS receives DB credentials, the origin secret and the photo-signing
  private key from Secrets Manager.

| Variable | Local default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | ECS supplies `0.0.0.0` |
| `PORT` | `3000` | Listen port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Exact CORS origin; HTTPS required in production |
| `ENABLE_LOCAL_UPLOADS` | `false` | Legacy unmasked upload testing only; forbidden in production |
| `UPLOAD_DIR` | `./uploads` | Private directory, only created if legacy uploads enabled |
| `MAX_UPLOAD_BYTES` | `10485760` | Legacy upload byte limit |
| `ORIGIN_VERIFY_SECRET` | unset | Required in production |
| `DATABASE_HOST` | unset | Enables DB readiness; required in production |
| `DATABASE_PORT` | `5432` | PostgreSQL port |
| `DATABASE_NAME` | unset | Required when DB is configured |
| `DATABASE_USER` | unset | Supplied via Secrets Manager in ECS |
| `DATABASE_PASSWORD` | unset | Supplied via Secrets Manager in ECS |
| `DATABASE_CA_FILE` | unset | Trusted RDS CA PEM file; required in production (local DB may omit TLS) |
| `MEDIA_BUCKET` / `REVEAL_BUCKET` | unset | S3 buckets for eye strips / faces; required in production |
| `MEDIA_KEY_PAIR_ID` / `MEDIA_PRIVATE_KEY` | unset | CloudFront public key ID and private PEM for signed URLs; required in production |
| `LOCAL_MEDIA_DIR` / `LOCAL_MEDIA_SECRET` | `./media` / random | Local photo storage and URL-signing secret when S3 is not configured |
| `PHOTO_RETENTION_DAYS` | `30` | Party/photo lifetime |
| `RATE_LIMIT` | on | Set `off` only for tests |

## Legacy upload tests, not the game upload API

`POST /api/uploads` is **disabled by default** and responds with JSON `404`.
To test the pre-existing private disk pipeline locally only, set
`ENABLE_LOCAL_UPLOADS=true` in `.env`, then:

```sh
curl -F 'photo=@portrait.jpg' http://127.0.0.1:3000/api/uploads
```

It accepts one `photo` file and no fields: JPEG/PNG/WebP, 10 MiB maximum, single
frame, up to 20 megapixels. It validates decoded content, auto-orients, resizes to
fit 2048 x 2048, strips EXIF/GPS, and writes private WebP under a generated UUID.
Temporary inputs are cleaned after success or failure. Success returns `201`
with `{ "id", "contentType", "width", "height", "size" }`.

This legacy route does **not** disguise a face and is unrelated to the game's
`PUT /api/parties/:code/photo`. Do not enable it on a public server.

Errors use `{ "error": "message" }`: `400` invalid/missing fields, `413` too large,
`415` unsupported type, `422` invalid image content, `429` rate limit (20 local
upload attempts per IP per 15 minutes). Unexpected failures are logged and return
generic `500` messages.

## Not yet implemented

Host transfer if the host leaves, removing players after guessing starts,
pagination for very large parties, and per-party rate limits shared across
tasks (current limits are per task, per IP).

See the sibling [AWS project](../guess-whos-santa-infra/README.md) for deployment.
