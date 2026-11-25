import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createRepository, migrate } from '../src/db.js';
import { createLocalStorage, createS3Storage, processPhoto } from '../src/photos.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'set TEST_DATABASE_URL (see README) to run party tests';
let admin;
let pool;
let schema;

before(async () => {
  if (skip) return;
  schema = `test_${randomBytes(6).toString('hex')}`;
  admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await migrate(pool);
  await migrate(pool);
});

after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function serve(t) {
  const directory = await mkdtemp(join(tmpdir(), 'santa-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createApp({ ...readConfig({}), rateLimitEnabled: false }, {
    checkDatabase: () => pool.query('SELECT 1'),
    repository: createRepository(pool),
    storage: createLocalStorage({ directory, secret: 'test-secret' }),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, json, body, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(json && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };
  return { base, call, directory };
}

const photo = (background) => sharp({
  create: { width: 64, height: 64, channels: 3, background },
}).jpeg().toBuffer();

function photoForm(buffer, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'me.jpg');
  return form;
}

async function party(call) {
  const host = (await call('POST', '/api/parties', { json: { name: 'Mom' } })).body;
  const ava = (await call('POST', `/api/parties/${host.code}/players`, { json: { name: 'Ava' } })).body;
  const ben = (await call('POST', `/api/parties/${host.code.toLowerCase()}/players`, { json: { name: 'Ben' } })).body;
  return { code: host.code, host, ava, ben };
}

test('a full party: masked eyes before reveal, real faces only for members after reveal', { skip }, async (t) => {
  const { base, call, directory } = await serve(t);
  const { code, host, ava, ben } = await party(call);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'ava ' } })).status, 409);

  assert.equal((await call('GET', `/api/parties/${code}`)).status, 401);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: ben.token })).body.me.name, 'Ben');

  for (const [player, color] of [[host, 'red'], [ava, 'green'], [ben, 'blue']]) {
    const upload = await call('PUT', `/api/parties/${code}/photo`, {
      token: player.token, body: photoForm(await photo(color), { x: 0, y: 0, zoom: 1.5 }),
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.me.hasPhoto, true);
  }
  const stored = await readdir(directory, { recursive: true });
  assert.equal(stored.filter((file) => file.endsWith('.webp')).length, 6);

  assert.equal((await call('POST', `/api/parties/${code}/start`, { token: ava.token })).status, 403);
  assert.equal((await call('POST', `/api/parties/${code}/reveal`, { token: host.token })).status, 409);
  const started = await call('POST', `/api/parties/${code}/start`, { token: host.token });
  assert.equal(started.body.phase, 'guessing');
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'Late' } })).status, 409);
  assert.equal((await call('PUT', `/api/parties/${code}/photo`, {
    token: ava.token, body: photoForm(await photo('pink')),
  })).status, 409);

  const guessing = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const serialized = JSON.stringify(guessing);
  assert.ok(!serialized.includes('reveals/'), 'no face URLs before reveal');
  for (const santa of guessing.santas) {
    assert.deepEqual(Object.keys(santa).sort(), ['eyesUrl', 'guesses', 'id', 'isMine', 'myGuess', 'number', 'ownerId']);
    assert.ok(santa.ownerId === null || santa.isMine, 'owners of other Santas stay hidden');
  }
  const eyes = await fetch(base + guessing.santas[0].eyesUrl);
  assert.equal(eyes.status, 200);
  assert.deepEqual(await sharp(Buffer.from(await eyes.arrayBuffer())).metadata().then(({ width, height }) => [width, height]), [420, 96]);
  const tampered = guessing.santas[0].eyesUrl.replace('media/', 'reveals/');
  assert.equal((await fetch(base + tampered)).status, 404);

  // Ava learns which Santa is hers but nobody else's owner.
  const mine = guessing.santas.find((santa) => santa.isMine);
  const others = guessing.santas.filter((santa) => !santa.isMine);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${mine.id}`, {
    token: ava.token, json: { playerId: host.playerId },
  })).status, 400);
  const first = await call('PUT', `/api/parties/${code}/guesses/${others[0].id}`, {
    token: ava.token, json: { playerId: host.playerId },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.santas.find((santa) => santa.id === others[0].id).myGuess, host.playerId);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${others[0].id}`, {
    token: ava.token, json: { playerId: ben.playerId },
  })).status, 409, 'only one guess per Santa');
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${others[1].id}`, {
    token: ava.token, json: { playerId: ava.playerId },
  })).status, 400);
  await call('PUT', `/api/parties/${code}/guesses/${others[1].id}`, {
    token: ava.token, json: { playerId: ben.playerId },
  });

  assert.equal((await call('POST', `/api/parties/${code}/reveal`, { token: ben.token })).status, 403);
  const revealed = await call('POST', `/api/parties/${code}/reveal`, { token: host.token });
  assert.equal(revealed.body.phase, 'reveal');
  const outsider = (await call('POST', '/api/parties', { json: { name: 'Stranger' } })).body;
  assert.equal((await call('GET', `/api/parties/${code}`, { token: outsider.token })).status, 401);

  const reveal = (await call('GET', `/api/parties/${code}`, { token: ben.token })).body;
  const avaSanta = reveal.santas.find((santa) => santa.playerId === ava.playerId);
  const face = await fetch(base + avaSanta.faceUrl);
  assert.equal(face.status, 200);
  assert.equal(face.headers.get('cache-control'), 'private, no-store');
  const faceInfo = await sharp(Buffer.from(await face.arrayBuffer())).metadata();
  assert.equal(faceInfo.format, 'webp');
  assert.equal(faceInfo.exif, undefined);
  const correct = Number(others[0].id === reveal.santas.find((s) => s.playerId === host.playerId).id)
    + Number(others[1].id === reveal.santas.find((s) => s.playerId === ben.playerId).id);
  assert.equal(reveal.leaderboard.find((row) => row.playerId === ava.playerId).score, correct);
  const expired = avaSanta.faceUrl.replace(/expires=\d+/, 'expires=1');
  assert.equal((await fetch(base + expired)).status, 404);
});

test('host manages the lobby and polling uses ETags', { skip }, async (t) => {
  const { call } = await serve(t);
  const { code, host, ava, ben } = await party(call);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/${ben.playerId}`, { token: ava.token })).status, 403);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/${host.playerId}`, { token: host.token })).status, 400);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/not-a-uuid`, { token: host.token })).status, 404);
  const removed = await call('DELETE', `/api/parties/${code}/players/${ben.playerId}`, { token: host.token });
  assert.deepEqual(removed.body.players.map((player) => player.name), ['Mom', 'Ava']);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: ben.token })).status, 401);

  const first = await call('GET', `/api/parties/${code}`, { token: ava.token });
  const etag = first.headers.get('etag');
  assert.equal((await call('GET', `/api/parties/${code}`, {
    token: ava.token, headers: { 'If-None-Match': etag },
  })).status, 304);
  await call('POST', `/api/parties/${code}/players`, { json: { name: 'Cy' } });
  assert.equal((await call('GET', `/api/parties/${code}`, {
    token: ava.token, headers: { 'If-None-Match': etag },
  })).status, 200);
  assert.equal((await call('POST', `/api/parties/${code}/start`, { token: host.token })).status, 409,
    'needs at least two Santa photos');

  await pool.query("UPDATE parties SET created_at = now() - interval '31 days' WHERE code = $1", [code]);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: host.token })).status, 401, 'expired party is inaccessible');
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'Dee' } })).status, 404);
  assert.ok(await createRepository(pool).deleteExpiredParties(30) >= 1);
  assert.equal((await pool.query('SELECT 1 FROM players WHERE party_id IN (SELECT id FROM parties WHERE code = $1)', [code])).rowCount, 0);
});

test('rejects bad names, codes, images, and alignment', { skip }, async (t) => {
  const { call } = await serve(t);
  assert.equal((await call('POST', '/api/parties', { json: { name: ' ' } })).status, 400);
  assert.equal((await call('POST', '/api/parties', { json: { name: '<b>' } })).status, 400);
  assert.equal((await call('POST', '/api/parties/NOPE!!/players', { json: { name: 'A' } })).status, 404);
  const { code, host } = await party(call);
  const bad = await call('PUT', `/api/parties/${code}/photo`, {
    token: host.token, body: photoForm(Buffer.from('not an image')),
  });
  assert.equal(bad.status, 422);
  const offside = await call('PUT', `/api/parties/${code}/photo`, {
    token: host.token, body: photoForm(await photo('red'), { zoom: 9 }),
  });
  assert.equal(offside.status, 422);
});

test('eye strip contains only the eye-window region of the photo', async () => {
  // Top half white, bottom half black; eye window sits just above the vertical center.
  const source = await sharp({ create: { width: 400, height: 440, channels: 3, background: 'black' } })
    .composite([{ input: { create: { width: 400, height: 205, channels: 3, background: 'white' } }, left: 0, top: 0 }])
    .png().toBuffer();
  const { eyes, face } = await processPhoto(source, 'image/png', { x: 0, y: 0, zoom: 1 });
  const { data, info } = await sharp(eyes).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [420, 96]);
  const pixel = (x, y) => data[(y * info.width + x) * info.channels];
  assert.ok(pixel(200, 10) > 200, 'top of window is the white part of the photo');
  assert.ok(pixel(200, 90) < 50, 'bottom of window is the black part of the photo');
  assert.equal((await sharp(face).metadata()).width, 400);
});

test('production face URLs are CloudFront-signed, path-scoped, and short-lived', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const storage = createS3Storage({
    region: 'us-east-1', mediaBucket: 'm', revealBucket: 'r', publicOrigin: 'https://guesswhossanta.com',
    keyPairId: 'KTEST', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  });
  const expiresAt = new Date('2030-01-01T00:00:00Z');
  const url = new URL(storage.url('reveals/p/f.webp', expiresAt));
  assert.equal(url.origin + url.pathname, 'https://guesswhossanta.com/reveals/p/f.webp');
  assert.equal(url.searchParams.get('Key-Pair-Id'), 'KTEST');
  assert.equal(url.searchParams.get('Expires'), String(expiresAt.getTime() / 1000));
  const policy = JSON.stringify({ Statement: [{
    Resource: 'https://guesswhossanta.com/reveals/p/f.webp',
    Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt.getTime() / 1000 } },
  }] });
  const signature = url.searchParams.get('Signature').replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
  assert.ok(createVerify('RSA-SHA1').update(policy).verify(publicKey, signature, 'base64'));
});

test('members add players without phones and play for them', { skip }, async (t) => {
  const { call } = await serve(t);
  const { code, host, ava, ben } = await party(call);
  const added = await call('POST', `/api/parties/${code}/added-players`, { token: ava.token, json: { name: 'Tiny Tim' } });
  assert.equal(added.status, 201);
  const tim = added.body.players.find((p) => p.name === 'Tiny Tim');
  assert.equal(tim.addedBy, ava.playerId);
  assert.equal((await call('POST', `/api/parties/${code}/added-players`, { json: { name: 'Nope' } })).status, 401);
  assert.equal((await call('POST', `/api/parties/${code}/added-players`, { token: ben.token, json: { name: 'tiny tim' } })).status, 409);
  const ben2 = (await call('POST', `/api/parties/${code}/added-players`, { token: ben.token, json: { name: 'Baby Bo' } })).body
    .players.find((p) => p.name === 'Baby Bo');

  const upload = (token, as, color) => call('PUT', `/api/parties/${code}/photo${as ? `?as=${as}` : ''}`, {
    token, body: photoForm(color),
  });
  assert.equal((await upload(ben.token, tim.id, await photo('red'))).status, 404, "can't act for someone else's player");
  const timPhoto = await upload(ava.token, tim.id, await photo('green'));
  assert.equal(timPhoto.status, 201);
  assert.equal(timPhoto.body.me.hasPhoto, false, 'photo belongs to Tim, not Ava');
  assert.ok(timPhoto.body.players.find((p) => p.id === tim.id).eyesUrl);
  assert.equal((await upload(host.token, null, await photo('blue'))).status, 201);
  assert.equal((await upload(ben.token, ben2.id, await photo('pink'))).status, 201);
  assert.equal((await call('POST', `/api/parties/${code}/start`, { token: host.token })).status, 200);

  const state = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const timSanta = state.santas.find((santa) => santa.ownerId === tim.id);
  assert.ok(timSanta && !timSanta.isMine);
  assert.equal(state.santas.filter((santa) => santa.ownerId).length, 1, 'only my crew owners are visible');
  const other = state.santas.find((santa) => !santa.ownerId);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${timSanta.id}`, {
    token: ava.token, json: { playerId: tim.id },
  })).status, 400, "Ava can't score on the Santa she uploaded");
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${timSanta.id}?as=${tim.id}`, {
    token: ava.token, json: { playerId: host.playerId },
  })).status, 400, 'Tim cannot guess his own Santa');
  const guessed = await call('PUT', `/api/parties/${code}/guesses/${other.id}?as=${tim.id}`, {
    token: ava.token, json: { playerId: host.playerId },
  });
  assert.equal(guessed.status, 200);
  const card = guessed.body.santas.find((santa) => santa.id === other.id);
  assert.deepEqual([card.guesses[tim.id], card.myGuess], [host.playerId, null], "Tim's guess is separate from Ava's");
  assert.equal(guessed.body.players.find((p) => p.id === tim.id).guessCount, 1);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${other.id}?as=${tim.id}`, {
    token: ben.token, json: { playerId: host.playerId },
  })).status, 404);

  const revealed = (await call('POST', `/api/parties/${code}/reveal`, { token: host.token })).body;
  assert.ok(revealed.leaderboard.some((row) => row.playerId === tim.id));
  assert.equal(revealed.santas.find((santa) => santa.playerId === tim.id).faceUrl.includes('reveals/'), true);
});

test('added players are removed by their adder or the host, and leave with their adder', { skip }, async (t) => {
  const { call, directory } = await serve(t);
  const { code, host, ava, ben } = await party(call);
  const add = async (token, name) => (await call('POST', `/api/parties/${code}/added-players`, { token, json: { name } }))
    .body.players.find((p) => p.name === name);
  const tim = await add(ava.token, 'Tim');
  const sue = await add(ava.token, 'Sue');
  const bo = await add(ben.token, 'Bo');
  assert.equal((await call('PUT', `/api/parties/${code}/photo?as=${sue.id}`, { token: ava.token, body: photoForm(await photo('red')) })).status, 201);

  assert.equal((await call('DELETE', `/api/parties/${code}/players/${bo.id}`, { token: ava.token })).status, 403);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/${tim.id}`, { token: ava.token })).status, 200);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/${bo.id}`, { token: host.token })).status, 200);
  const after = await call('DELETE', `/api/parties/${code}/players/${ava.playerId}`, { token: host.token });
  assert.deepEqual(after.body.players.map((p) => p.name), ['Mom', 'Ben'], "Ava's added players leave with her");
  assert.equal((await readdir(directory, { recursive: true })).filter((file) => file.endsWith('.webp')).length, 0);
});

test('hosts name and rename parties; invitees preview the name', { skip }, async (t) => {
  const { call } = await serve(t);
  const named = (await call('POST', '/api/parties', { json: { name: 'Mom', partyName: '  Smith   Family Christmas ' } })).body;
  assert.equal(named.name, 'Smith Family Christmas');
  const { code, host, ava } = await party(call);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: ava.token })).body.name, 'Mom’s party');
  assert.deepEqual((await call('GET', `/api/parties/${code}/invite`)).body, { code, name: null, open: true }, 'host name stays private');
  assert.deepEqual((await call('GET', `/api/parties/${named.code}/invite`)).body, { code: named.code, name: 'Smith Family Christmas', open: true });
  assert.equal((await call('GET', '/api/parties/ZZZZZZ/invite')).status, 404);

  assert.equal((await call('PATCH', `/api/parties/${code}`, { token: ava.token, json: { name: 'Mine now' } })).status, 403);
  assert.equal((await call('PATCH', `/api/parties/${code}`, { token: host.token, json: { name: ' ' } })).status, 400);
  assert.equal((await call('PATCH', `/api/parties/${code}`, { token: host.token, json: { name: 'x'.repeat(41) } })).status, 400);
  const renamed = await call('PATCH', `/api/parties/${code}`, { token: host.token, json: { name: 'Work Holiday Party' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Work Holiday Party');
  assert.equal((await call('GET', `/api/parties/${code}`, { token: ava.token })).body.name, 'Work Holiday Party');
  assert.equal((await call('POST', '/api/parties', { json: { name: 'Mom', partyName: '<b>' } })).status, 400);

  await call('PUT', `/api/parties/${named.code}/photo`, { token: named.token, body: photoForm(await photo('red')) });
  const guest = (await call('POST', `/api/parties/${named.code}/players`, { json: { name: 'Ava' } })).body;
  await call('PUT', `/api/parties/${named.code}/photo`, { token: guest.token, body: photoForm(await photo('blue')) });
  assert.equal((await call('POST', `/api/parties/${named.code}/start`, { token: named.token })).status, 200);
  assert.deepEqual((await call('GET', `/api/parties/${named.code}/invite`)).body, { code: named.code, name: null, open: false });
});
