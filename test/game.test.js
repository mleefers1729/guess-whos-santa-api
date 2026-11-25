import assert from 'node:assert/strict';
import { createHash, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
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

async function serve(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'santa-media-'));
  const mail = new Map();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createApp({ ...readConfig({}), rateLimitEnabled: false, ...options.config }, {
    checkDatabase: () => pool.query('SELECT 1'),
    repository: createRepository(pool),
    storage: createLocalStorage({ directory, secret: 'test-secret' }),
    sendLoginCode: Object.hasOwn(options, 'sendLoginCode') ? options.sendLoginCode : async ({ email, code }) => mail.set(email, code),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, cookie, json, body, headers = {} } = {}) => {
    const sessionCookie = cookie ?? (token?.startsWith('santa-session=') ? token : undefined);
    const response = await fetch(base + path, {
      method,
      headers: {
        'X-Santa-Request': '1',
        ...(token && !sessionCookie && { Authorization: `Bearer ${token}` }),
        ...(sessionCookie && { Cookie: sessionCookie }),
        ...(json && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };
  const signIn = async (email = `${randomBytes(8).toString('hex')}@example.com`, parties = []) => {
    const sent = await call('POST', '/api/auth/code', { json: { email } });
    assert.equal(sent.status, 200);
    const challenge = sent.headers.getSetCookie().find((value) => value.startsWith('santa-login=')).split(';')[0];
    const verified = await call('POST', '/api/auth/verify', {
      cookie: challenge, json: { code: mail.get(email.trim().toLowerCase()), parties },
    });
    assert.equal(verified.status, 200);
    return {
      ...verified,
      cookie: verified.headers.getSetCookie().find((value) => value.startsWith('santa-session=')).split(';')[0],
    };
  };
  const createHost = async (json) => {
    const { cookie } = await signIn();
    const result = await call('POST', '/api/parties', { cookie, json });
    // Existing game cases use `token` for credentials; hosts now authenticate with a cookie.
    if (result.status === 201) result.body.token = cookie;
    return result;
  };
  return { base, call, directory, createHost, signIn, mail };
}

const photo = (background) => sharp({
  create: { width: 64, height: 64, channels: 3, background },
}).jpeg().toBuffer();

function photoForm(buffer, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ source: 'photos', shareConsent: true, ...fields })) form.append(key, String(value));
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'me.jpg');
  return form;
}

async function party(call, createHost) {
  const host = (await createHost({ name: 'Mom' })).body;
  const ava = (await call('POST', `/api/parties/${host.code}/players`, { json: { name: 'Ava' } })).body;
  const ben = (await call('POST', `/api/parties/${host.code.toLowerCase()}/players`, { json: { name: 'Ben' } })).body;
  for (const player of [host, ava, ben]) await allowPhotos(call, host.code, player.token);
  return { code: host.code, host, ava, ben };
}

async function allowPhotos(call, code, token, as) {
  const result = await call('PUT', `/api/parties/${code}/media-consent${as ? `?as=${as}` : ''}`, {
    token, json: { kind: 'photos', granted: true },
  });
  assert.equal(result.status, 200);
}

test('monitor requires the admin session and counts visits and retained parties', { skip }, async (t) => {
  const { call, signIn } = await serve(t);
  assert.equal((await call('GET', '/api/monitor/stats')).status, 401);
  const other = await signIn();
  assert.equal((await call('GET', '/api/monitor/stats', { cookie: other.cookie })).status, 403);
  const adminUser = await signIn('mitchell.leefers@gmail.com');
  const before = (await call('GET', '/api/monitor/stats', { cookie: adminUser.cookie })).body;

  const visit = await call('POST', '/api/monitor/visit');
  assert.equal(visit.status, 204);
  const visitorCookie = visit.headers.getSetCookie().find((value) => value.startsWith('santa-visitor='));
  assert.match(visitorCookie, /HttpOnly/i);
  assert.match(visitorCookie, /SameSite=Lax/i);
  assert.equal((await call('POST', '/api/monitor/visit', { cookie: visitorCookie.split(';')[0] })).status, 204);
  assert.equal((await call('POST', '/api/monitor/visit', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const created = await call('POST', '/api/parties', { cookie: adminUser.cookie, json: { name: 'Host' } });
  assert.equal(created.status, 201);
  assert.equal((await call('POST', `/api/parties/${created.body.code}/players`, { json: { name: 'Guest' } })).status, 201);

  const stats = await call('GET', '/api/monitor/stats', { cookie: adminUser.cookie });
  assert.equal(stats.headers.get('cache-control'), 'no-store');
  assert.equal(Number(stats.body.browsers), Number(before.browsers) + 1);
  assert.equal(Number(stats.body.page_loads), Number(before.page_loads) + 2);
  assert.equal(Number(stats.body.parties_created), Number(before.parties_created) + 1);
  assert.equal(Number(stats.body.active_parties), Number(before.active_parties) + 1);
  assert.equal(Number(stats.body.active_players), Number(before.active_players) + 2);
  await pool.query('DELETE FROM parties WHERE code = $1', [created.body.code]);
  const after = (await call('GET', '/api/monitor/stats', { cookie: adminUser.cookie })).body;
  assert.equal(Number(after.parties_created), Number(stats.body.parties_created));
  assert.equal(Number(after.active_players), Number(before.active_players));
});

test('email accounts restore hosted parties across visits and API instances without local tokens', { skip }, async (t) => {
  const { call, signIn } = await serve(t);
  assert.equal((await call('POST', '/api/parties', { json: { name: 'Host' } })).status, 401);
  const login = await signIn();
  const cookie = login.cookie;
  assert.match(login.headers.getSetCookie().find((value) => value.startsWith('santa-session=')), /HttpOnly/i);
  assert.match(login.headers.getSetCookie().find((value) => value.startsWith('santa-session=')), /SameSite=Lax/i);
  const created = await call('POST', '/api/parties', { cookie, json: { name: 'Host', partyName: 'Saved party' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.token, undefined, 'account credentials stay in an HttpOnly cookie');
  const code = created.body.code;
  assert.equal((await call('GET', `/api/parties/${code}`, { cookie })).body.me.isHost, true);
  assert.equal((await call('POST', '/api/parties', {
    cookie, json: { name: 'CSRF' }, headers: { 'X-Santa-Request': '' },
  })).status, 403);
  assert.equal((await call('POST', '/api/parties', {
    cookie, json: { name: 'Cross-site' }, headers: { 'Sec-Fetch-Site': 'cross-site' },
  })).status, 403);

  const restarted = await serve(t);
  const restored = await restarted.call('GET', '/api/auth/session', { cookie });
  assert.equal(restored.body.user.id, login.body.user.id);
  assert.equal(restored.body.parties.find((p) => p.code === code).name, 'Saved party');
  await pool.query("UPDATE login_codes SET sent_at = now() - interval '2 minutes' WHERE email = $1", [login.body.user.email]);
  const anotherDevice = await restarted.signIn(login.body.user.email);
  assert.equal(anotherDevice.body.user.id, login.body.user.id);
  assert.equal((await restarted.call('GET', `/api/parties/${code}`, { cookie: anotherDevice.cookie })).body.me.isHost, true);
  await call('POST', '/api/auth/logout', { cookie });
  assert.equal((await call('GET', '/api/auth/session', { cookie })).body.user, null);
  assert.equal((await call('GET', `/api/parties/${code}`, { cookie })).status, 401);
  assert.equal((await restarted.call('GET', `/api/parties/${code}`, { cookie: anotherDevice.cookie })).status, 200,
    'signing out revokes only this device');
});

test('guest and legacy-host access link only with the original token and retain their player identity', { skip }, async (t) => {
  const { call, createHost, signIn } = await serve(t);
  const host = (await createHost({ name: 'Legacy host' })).body;
  const legacyToken = randomBytes(32).toString('base64url');
  await pool.query('UPDATE players SET account_id = NULL, token_hash = $2 WHERE id = $1', [
    host.playerId, createHash('sha256').update(legacyToken).digest(),
  ]);
  const guest = (await call('POST', `/api/parties/${host.code}/players`, { json: { name: 'Guest' } })).body;
  assert.ok(guest.token);
  const saved = await signIn(undefined, [{ code: host.code, token: legacyToken }]);
  assert.deepEqual(saved.body.claimed, [host.code]);
  const returnedHost = await call('GET', `/api/parties/${host.code}`, { cookie: saved.cookie });
  assert.equal(returnedHost.body.me.id, host.playerId);
  assert.equal(returnedHost.body.me.isHost, true);
  assert.equal((await call('GET', `/api/parties/${host.code}`, { token: legacyToken })).status, 401,
    'a legacy token cannot bypass logout once linked');
  const stolen = await signIn(undefined, [{ code: host.code, token: legacyToken }]);
  assert.deepEqual(stolen.body.rejected, [host.code], 'a bound party cannot be moved to another account');
  assert.deepEqual(stolen.body.parties, []);
  const guestSaved = await signIn(undefined, [{ code: host.code, token: guest.token }]);
  assert.equal((await call('GET', `/api/parties/${host.code}`, { cookie: guestSaved.cookie })).body.me.id, guest.playerId);
  const rejoin = await call('POST', `/api/parties/${host.code}/players`, {
    cookie: guestSaved.cookie, json: { name: 'A new duplicate name' },
  });
  assert.equal(rejoin.status, 200);
  assert.equal(rejoin.body.playerId, guest.playerId);
  assert.equal(rejoin.body.token, undefined);
  const guessed = await signIn(undefined, [{ code: host.code, token: randomBytes(32).toString('base64url') }]);
  assert.deepEqual(guessed.body.claimed, []);
  assert.equal((await call('GET', `/api/parties/${host.code}`, { cookie: guessed.cookie })).status, 401);
});

test('email codes are browser-bound, single-use, time-limited, attempt-limited, and throttled per email', { skip }, async (t) => {
  const { call, mail } = await serve(t);
  const email = `${randomBytes(8).toString('hex')}@example.com`;
  const sent = await call('POST', '/api/auth/code', { json: { email } });
  assert.equal(sent.status, 200);
  assert.ok(!JSON.stringify(sent.body).includes(mail.get(email)), 'the API never returns the code');
  const cookie = sent.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call('POST', '/api/auth/verify', { json: { code: mail.get(email) } })).status, 400);
  assert.equal((await call('POST', '/api/auth/code', { json: { email: email.toUpperCase() } })).status, 429);
  const wrong = mail.get(email) === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await call('POST', '/api/auth/verify', { cookie, json: { code: wrong } })).status, 400);
  }
  assert.equal((await call('POST', '/api/auth/verify', { cookie, json: { code: mail.get(email) } })).status, 400);
  for (let sentCount = 1; sentCount < 5; sentCount += 1) {
    await pool.query("UPDATE login_codes SET sent_at = now() - interval '2 minutes' WHERE email = $1", [email]);
    assert.equal((await call('POST', '/api/auth/code', { json: { email } })).status, 200);
  }
  await pool.query("UPDATE login_codes SET sent_at = now() - interval '2 minutes' WHERE email = $1", [email]);
  assert.equal((await call('POST', '/api/auth/code', { json: { email } })).status, 429);
  await pool.query("UPDATE login_codes SET window_started_at = now() - interval '2 hours' WHERE email = $1", [email]);
  const fresh = await call('POST', '/api/auth/code', { json: { email } });
  const freshCookie = fresh.headers.getSetCookie()[0].split(';')[0];
  const verified = await call('POST', '/api/auth/verify', { cookie: freshCookie, json: { code: mail.get(email) } });
  assert.equal(verified.status, 200);
  assert.equal((await call('POST', '/api/auth/verify', { cookie: freshCookie, json: { code: mail.get(email) } })).status, 400);

  const expiringEmail = `${randomBytes(8).toString('hex')}@example.com`;
  const expiring = await call('POST', '/api/auth/code', { json: { email: expiringEmail } });
  await pool.query('UPDATE login_codes SET expires_at = now() WHERE email = $1', [expiringEmail]);
  assert.equal((await call('POST', '/api/auth/verify', {
    cookie: expiring.headers.getSetCookie()[0].split(';')[0], json: { code: mail.get(expiringEmail) },
  })).status, 400);
});

test('sessions renew active browsers, enforce idle and absolute expiry, and do not resurrect expired parties', { skip }, async (t) => {
  const { call, signIn } = await serve(t);
  const login = await signIn();
  const id = login.body.user.id;
  const host = (await call('POST', '/api/parties', { cookie: login.cookie, json: { name: 'Host' } })).body;
  await pool.query("UPDATE account_sessions SET expires_at = now() + interval '1 day' WHERE account_id = $1", [id]);
  const renewed = await call('GET', '/api/auth/session', { cookie: login.cookie });
  assert.equal(renewed.body.user.id, id);
  assert.ok(renewed.headers.getSetCookie().some((value) => /Max-Age=7776000/.test(value)));
  await pool.query("UPDATE parties SET created_at = now() - interval '31 days' WHERE code = $1", [host.code]);
  assert.deepEqual((await call('GET', '/api/auth/session', { cookie: login.cookie })).body.parties, []);
  await pool.query("UPDATE account_sessions SET created_at = now() - interval '366 days' WHERE account_id = $1", [id]);
  assert.equal((await call('GET', '/api/auth/session', { cookie: login.cookie })).body.user, null);
  const again = await signIn();
  await pool.query('UPDATE account_sessions SET expires_at = now() WHERE account_id = $1', [again.body.user.id]);
  assert.equal((await call('GET', '/api/auth/session', { cookie: again.cookie })).body.user, null);
});

test('email delivery failures are explicit and cannot produce a login session', { skip }, async (t) => {
  for (const sendLoginCode of [undefined, async () => { throw new Error('Simulated SES outage'); }]) {
    const { call } = await serve(t, { sendLoginCode });
    const email = `${randomBytes(8).toString('hex')}@example.com`;
    const sent = await call('POST', '/api/auth/code', { json: { email } });
    assert.equal(sent.status, 503);
    assert.match(sent.body.error, /not configured|Could not send/);
    assert.equal(sent.headers.getSetCookie().length, 0);
    assert.equal((await call('GET', '/api/auth/session')).body.user, null);
    const records = await pool.query('SELECT expires_at <= now() AS expired FROM login_codes WHERE email = $1', [email]);
    if (records.rowCount) assert.equal(records.rows[0].expired, true);
  }
});

test('HTTPS sign-in issues host-only Secure HttpOnly cookies and rejects cross-site auth writes', { skip }, async (t) => {
  const { call, mail } = await serve(t, { config: { secureCookies: true } });
  const email = `${randomBytes(8).toString('hex')}@example.com`;
  assert.equal((await call('POST', '/api/auth/code', {
    json: { email }, headers: { 'X-Santa-Request': '' },
  })).status, 403);
  const sent = await call('POST', '/api/auth/code', { json: { email } });
  const challenge = sent.headers.getSetCookie()[0];
  assert.match(challenge, /^__Host-santa-login=/);
  const verified = await call('POST', '/api/auth/verify', {
    cookie: challenge.split(';')[0], json: { code: mail.get(email) },
  });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie().find((value) => value.startsWith('__Host-santa-session='));
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*Path=\//i);
  assert.ok(!/;\s*Domain=/i.test(cookie));
});

test('media consent is explicit, persisted per player, private to their crew, and required for uploads', { skip }, async (t) => {
  const { call, directory, createHost } = await serve(t);
  const host = (await createHost({ name: 'Host' })).body;
  const code = host.code;
  const guest = (await call('POST', `/api/parties/${code}/players`, { json: { name: 'Guest' } })).body;
  const path = `/api/parties/${code}/media-consent`;
  const upload = (fields = {}) => call('PUT', `/api/parties/${code}/photo`, {
    token: host.token, body: photoForm(image, fields),
  });
  const image = await photo('green');
  const initial = await call('GET', `/api/parties/${code}`, { token: host.token });
  assert.deepEqual(initial.body.players.find((p) => p.id === host.playerId).mediaConsent, {});
  assert.equal((await upload()).status, 403);
  assert.equal((await call('PUT', path, { json: { kind: 'photos', granted: true } })).status, 401);
  for (const json of [{ kind: 'photos', granted: 'true' }, { kind: 'sharing', granted: true }, {}]) {
    assert.equal((await call('PUT', path, { token: host.token, json })).status, 400);
  }
  const allowed = await call('PUT', path, { token: host.token, json: { kind: 'camera', granted: true } });
  assert.equal(allowed.status, 200);
  assert.equal((await call('GET', `/api/parties/${code}`, {
    token: host.token, headers: { 'If-None-Match': initial.headers.get('etag') },
  })).status, 200, 'consent changes invalidate polling state');
  const saved = (await call('GET', `/api/parties/${code}`, { token: host.token })).body.players
    .find((p) => p.id === host.playerId).mediaConsent.camera;
  assert.equal(saved.granted, true);
  assert.equal(saved.recordedBy, host.playerId);
  assert.equal(saved.version, 1);
  assert.ok(Number.isFinite(Date.parse(saved.recordedAt)));
  assert.equal((await upload({ source: 'camera', shareConsent: false })).status, 400);
  assert.equal((await upload({ source: 'camera', shareConsent: '' })).status, 400);
  assert.equal((await upload({ source: 'photos' })).status, 403, 'camera consent is not library consent');
  assert.equal((await readdir(directory, { recursive: true })).length, 0, 'unconsented photos never reach storage');
  const uploaded = await upload({ source: 'camera' });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.players.find((p) => p.id === host.playerId).mediaConsent.sharing.granted, true);
  await call('PUT', path, { token: host.token, json: { kind: 'camera', granted: false } });
  assert.equal((await upload({ source: 'camera' })).status, 403, 'declining updates a previous grant');
  const stored = await pool.query('SELECT media_consent FROM players WHERE id = $1', [host.playerId]);
  assert.equal(stored.rows[0].media_consent.camera.granted, false);
  const outsiderView = (await call('GET', `/api/parties/${code}`, { token: guest.token })).body;
  assert.equal(Object.hasOwn(outsiderView.players.find((p) => p.id === host.playerId), 'mediaConsent'), false);

  const added = (await call('POST', `/api/parties/${code}/added-players`, {
    token: host.token, json: { name: 'Child' },
  })).body.players.find((p) => p.name === 'Child');
  assert.equal((await call('PUT', `${path}?as=${added.id}`, {
    token: guest.token, json: { kind: 'photos', granted: true },
  })).status, 404);
  await allowPhotos(call, code, host.token, added.id);
  const crew = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.equal(crew.players.find((p) => p.id === added.id).mediaConsent.photos.recordedBy, host.playerId);
  assert.equal(crew.players.find((p) => p.id === host.playerId).mediaConsent.photos, undefined);
});

test('a full party: masked eyes before reveal, real faces only for members after reveal', { skip }, async (t) => {
  const { base, call, directory, createHost } = await serve(t);
  const { code, host, ava, ben } = await party(call, createHost);
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
  assert.equal((await call('PUT', `/api/parties/${code}/media-consent`, {
    token: host.token, json: { kind: 'camera', granted: true },
  })).status, 409);
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
  const outsider = (await createHost({ name: 'Stranger' })).body;
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
  const { call, createHost } = await serve(t);
  const { code, host, ava, ben } = await party(call, createHost);
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
  const { call, createHost } = await serve(t);
  assert.equal((await createHost({ name: ' ' })).status, 400);
  assert.equal((await createHost({ name: '<b>' })).status, 400);
  assert.equal((await call('POST', '/api/parties/NOPE!!/players', { json: { name: 'A' } })).status, 404);
  const { code, host } = await party(call, createHost);
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
  const { call, createHost } = await serve(t);
  const { code, host, ava, ben } = await party(call, createHost);
  const added = await call('POST', `/api/parties/${code}/added-players`, { token: ava.token, json: { name: 'Tiny Tim' } });
  assert.equal(added.status, 201);
  const tim = added.body.players.find((p) => p.name === 'Tiny Tim');
  assert.equal(tim.addedBy, ava.playerId);
  assert.equal((await call('POST', `/api/parties/${code}/added-players`, { json: { name: 'Nope' } })).status, 401);
  assert.equal((await call('POST', `/api/parties/${code}/added-players`, { token: ben.token, json: { name: 'tiny tim' } })).status, 409);
  const ben2 = (await call('POST', `/api/parties/${code}/added-players`, { token: ben.token, json: { name: 'Baby Bo' } })).body
    .players.find((p) => p.name === 'Baby Bo');
  await allowPhotos(call, code, ava.token, tim.id);
  await allowPhotos(call, code, ben.token, ben2.id);

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
  const { call, directory, createHost } = await serve(t);
  const { code, host, ava, ben } = await party(call, createHost);
  const add = async (token, name) => (await call('POST', `/api/parties/${code}/added-players`, { token, json: { name } }))
    .body.players.find((p) => p.name === name);
  const tim = await add(ava.token, 'Tim');
  const sue = await add(ava.token, 'Sue');
  const bo = await add(ben.token, 'Bo');
  await allowPhotos(call, code, ava.token, sue.id);
  assert.equal((await call('PUT', `/api/parties/${code}/photo?as=${sue.id}`, { token: ava.token, body: photoForm(await photo('red')) })).status, 201);

  assert.equal((await call('DELETE', `/api/parties/${code}/players/${bo.id}`, { token: ava.token })).status, 403);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/${tim.id}`, { token: ava.token })).status, 200);
  assert.equal((await call('DELETE', `/api/parties/${code}/players/${bo.id}`, { token: host.token })).status, 200);
  const after = await call('DELETE', `/api/parties/${code}/players/${ava.playerId}`, { token: host.token });
  assert.deepEqual(after.body.players.map((p) => p.name), ['Mom', 'Ben'], "Ava's added players leave with her");
  assert.equal((await readdir(directory, { recursive: true })).filter((file) => file.endsWith('.webp')).length, 0);
});

test('hosts name and rename parties; invitees preview the name', { skip }, async (t) => {
  const { call, createHost } = await serve(t);
  const named = (await createHost({ name: 'Mom', partyName: '  Smith   Family Christmas ' })).body;
  assert.equal(named.name, 'Smith Family Christmas');
  const { code, host, ava } = await party(call, createHost);
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
  assert.equal((await createHost({ name: 'Mom', partyName: '<b>' })).status, 400);

  await allowPhotos(call, named.code, named.token);
  await call('PUT', `/api/parties/${named.code}/photo`, { token: named.token, body: photoForm(await photo('red')) });
  const guest = (await call('POST', `/api/parties/${named.code}/players`, { json: { name: 'Ava' } })).body;
  await allowPhotos(call, named.code, guest.token);
  await call('PUT', `/api/parties/${named.code}/photo`, { token: guest.token, body: photoForm(await photo('blue')) });
  assert.equal((await call('POST', `/api/parties/${named.code}/start`, { token: named.token })).status, 200);
  assert.deepEqual((await call('GET', `/api/parties/${named.code}/invite`)).body, { code: named.code, name: null, open: false });
});
