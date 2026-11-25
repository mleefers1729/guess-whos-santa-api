import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

async function serve(t, config = {}, dependencies = {}) {
  const app = await createApp({ ...readConfig({}), ...config }, dependencies);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('unmasked uploads are unavailable by default, even with valid image content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'santa-disabled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uploadDir = join(directory, 'uploads');
  const url = await serve(t, { uploadDir });
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'red' },
  }).png().toBuffer();
  const body = new FormData();
  body.append('photo', new Blob([image], { type: 'image/png' }), 'test.png');
  const response = await fetch(`${url}/api/uploads`, { method: 'POST', body });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Route not found' });
  await assert.rejects(access(uploadDir), { code: 'ENOENT' });
});

test('origin verification blocks direct and spoofed API traffic but permits ALB liveness', async (t) => {
  const url = await serve(t, { originVerifySecret: 'test-origin-secret' });
  assert.equal((await fetch(`${url}/health`)).status, 200);
  for (const headers of [{}, { 'X-Origin-Verify': 'wrong' }]) {
    assert.equal((await fetch(`${url}/api/health`, { headers })).status, 403);
  }
  const response = await fetch(`${url}/api/health`, {
    headers: { 'X-Origin-Verify': 'test-origin-secret' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readiness reports DB failure instead of claiming the API is ready', async (t) => {
  let available = true;
  const url = await serve(t, {}, { checkDatabase: async () => {
    if (!available) throw new Error('Simulated database outage');
  } });
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), {
    status: 'ok', database: 'connected',
  });
  available = false;
  const response = await fetch(`${url}/api/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', database: 'unavailable' });
});

test('production rejects unmasked uploads, insecure origin, and missing hosting configuration', () => {
  const env = {
    NODE_ENV: 'production',
    CLIENT_ORIGIN: 'https://guesswhossanta.com',
    ORIGIN_VERIFY_SECRET: 'test-only',
    DATABASE_HOST: 'test.invalid',
    DATABASE_USER: 'santa',
    DATABASE_PASSWORD: 'test-only',
    DATABASE_NAME: 'santa',
    DATABASE_CA_FILE: '/test/ca.pem',
    MEDIA_BUCKET: 'media-bucket',
    REVEAL_BUCKET: 'reveal-bucket',
    MEDIA_KEY_PAIR_ID: 'K123',
    MEDIA_PRIVATE_KEY: 'test-only',
  };
  assert.equal(readConfig(env).trustProxy, 2);
  assert.equal(readConfig(env).enableLocalUploads, false);
  assert.equal(readConfig(env).media.kind, 's3');
  assert.equal(readConfig(env).media.publicOrigin, 'https://guesswhossanta.com');
  assert.throws(() => readConfig({ ...env, ENABLE_LOCAL_UPLOADS: 'true' }), /Unmasked/);
  assert.throws(() => readConfig({ ...env, ENABLE_LOCAL_UPLOADS: 'yes' }), /true or false/);
  assert.throws(() => readConfig({ ...env, CLIENT_ORIGIN: 'http://guesswhossanta.com' }), /HTTPS/);
  for (const key of ['ORIGIN_VERIFY_SECRET', 'DATABASE_HOST', 'DATABASE_PASSWORD', 'DATABASE_CA_FILE',
    'MEDIA_BUCKET', 'REVEAL_BUCKET', 'MEDIA_KEY_PAIR_ID', 'MEDIA_PRIVATE_KEY']) {
    assert.throws(() => readConfig({ ...env, [key]: '' }), new RegExp(key));
  }
});
