import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

let server;
let baseUrl;
let uploadDir;
let photo;

before(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), 'santa-test-'));
  const app = await createApp({
    ...readConfig({}),
    uploadDir,
    maxUploadBytes: 1024,
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  photo = await sharp({
    create: { width: 16, height: 12, channels: 3, background: '#ff0000' },
  }).png().withMetadata({ exif: { IFD0: { Artist: 'Private name' } } }).toBuffer();
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

function sendPhoto(data = photo, type = 'image/png', field = 'photo') {
  const body = new FormData();
  body.append(field, new Blob([data], { type }), '../../unsafe.png');
  return fetch(`${baseUrl}/api/uploads`, { method: 'POST', body });
}

async function isolatedApp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'santa-limits-'));
  const app = await createApp({ ...readConfig({}), uploadDir: directory });
  const instance = app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    await new Promise((resolve) => instance.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('health endpoint supports the configured React origin and security headers', async () => {
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.deepEqual(await response.json(), { status: 'ok', name: 'guess-whos-santa-api' });
});

test('CORS does not grant access to another origin', async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://other.example' } });
  assert.notEqual(response.headers.get('access-control-allow-origin'), 'https://other.example');
});

test('React can preflight an upload request', async () => {
  const response = await fetch(`${baseUrl}/api/uploads`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('uploads normalize images, strip metadata, use generated names, and stay private', async () => {
  const response = await sendPhoto();
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.contentType, 'image/webp');
  assert.equal(result.width, 16);
  assert.equal(result.height, 12);
  const stored = await readFile(join(uploadDir, `${result.id}.webp`));
  const metadata = await sharp(stored).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
  assert.equal(result.size, stored.length);
  assert.deepEqual(await readdir(join(uploadDir, '.incoming')), []);
  assert.equal((await fetch(`${baseUrl}/uploads/${result.id}.webp`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/uploads/${result.id}`)).status, 404);
});

test('uploads reject missing files', async () => {
  const response = await fetch(`${baseUrl}/api/uploads`, { method: 'POST' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'A photo file is required' });
});

test('uploads reject unsupported file types', async () => {
  const response = await sendPhoto('not an image', 'image/svg+xml');
  assert.equal(response.status, 415);
});

test('uploads reject corrupt content and MIME spoofing without keeping files', async () => {
  const before = await readdir(uploadDir);
  for (const [data, type] of [['not an image', 'image/png'], [photo, 'image/jpeg']]) {
    const response = await sendPhoto(data, type);
    assert.equal(response.status, 422);
  }
  assert.deepEqual(await readdir(uploadDir), before);
  assert.deepEqual(await readdir(join(uploadDir, '.incoming')), []);
});

test('uploads enforce file size and field limits and clean temporary files', async () => {
  const before = await readdir(uploadDir);
  assert.equal((await sendPhoto(Buffer.alloc(1025))).status, 413);
  assert.equal((await sendPhoto(photo, 'image/png', 'wrong')).status, 400);
  const body = new FormData();
  body.append('photo', new Blob([photo], { type: 'image/png' }), 'one.png');
  body.append('photo', new Blob([photo], { type: 'image/png' }), 'two.png');
  assert.equal((await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body })).status, 400);
  assert.deepEqual(await readdir(uploadDir), before);
  assert.deepEqual(await readdir(join(uploadDir, '.incoming')), []);
});

test('unknown routes and malformed JSON return JSON errors', async () => {
  const missing = await fetch(`${baseUrl}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Route not found' });
  const malformed = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON body' });
});

test('configuration validates ports, upload limits, and exact client origins', () => {
  assert.equal(readConfig({}).port, 3000);
  assert.equal(readConfig({ PORT: '4567' }).port, 4567);
  for (const env of [
    { PORT: '0' }, { PORT: '65536' }, { PORT: 'abc' },
    { MAX_UPLOAD_BYTES: '-1' }, { MAX_UPLOAD_BYTES: '1.5' },
    { CLIENT_ORIGIN: '*' }, { CLIENT_ORIGIN: 'https://example.com/path' },
  ]) {
    assert.throws(() => readConfig(env));
  }
});

test('uploads resize large images and reject excessive decoded pixel counts', async (t) => {
  const url = await isolatedApp(t);
  for (const [width, height, status] of [[2500, 100, 201], [5000, 4001, 422]]) {
    const data = await sharp({
      create: { width, height, channels: 3, background: '#ff0000' },
    }).png().toBuffer();
    const body = new FormData();
    body.append('photo', new Blob([data], { type: 'image/png' }), 'large.png');
    const response = await fetch(`${url}/api/uploads`, { method: 'POST', body });
    assert.equal(response.status, status);
    if (status === 201) {
      const result = await response.json();
      assert.equal(result.width, 2048);
      assert.ok(result.height <= 2048);
    }
  }
});

test('uploads are rate limited with a JSON error', async (t) => {
  const url = await isolatedApp(t);
  let response;
  for (let attempt = 0; attempt < 21; attempt++) {
    response = await fetch(`${url}/api/uploads`, { method: 'POST' });
    assert.equal(response.status, attempt < 20 ? 400 : 429);
    await response.arrayBuffer();
  }
  assert.ok(response.headers.has('retry-after'));
  response = await fetch(`${url}/api/uploads`, { method: 'POST' });
  assert.deepEqual(await response.json(), { error: 'Too many uploads; try again later' });
});
