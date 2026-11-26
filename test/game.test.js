import assert from 'node:assert/strict';
import { createHash, createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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
import { buildState } from '../src/game.js';
import { createNotificationWorker } from '../src/notifications.js';
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
        ...(token && !token.startsWith('santa-session=') && { Authorization: `Bearer ${token}` }),
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
  const ava = (await call('POST', `/api/parties/${host.code}/players`, { json: { name: 'Ava', email: 'ava@example.com' } })).body;
  const ben = (await call('POST', `/api/parties/${host.code.toLowerCase()}/players`, { json: { name: 'Ben', email: 'ben@example.com' } })).body;
  for (const player of [host, ava, ben]) await allowPhotos(call, host.code, player.token);
  return { code: host.code, host, ava, ben };
}

async function allowPhotos(call, code, token, as) {
  const result = await call('PUT', `/api/parties/${code}/media-consent${as ? `?as=${as}` : ''}`, {
    token, json: { kind: 'photos', granted: true },
  });
  assert.equal(result.status, 200);
}

test('each managed player gets a stable shuffled order and their own reveal', () => {
  const players = Array.from({ length: 10 }, (_, i) => ({
    id: `player-${i}`, name: `Player ${i}`, is_host: i === 0,
    added_by: i === 1 ? 'player-0' : null, revealed_at: i === 1 ? new Date() : null,
  }));
  const photos = players.map((player, i) => ({
    id: `photo-${i}`, player_id: player.id, eyes_key: `eyes/${i}`, face_key: `faces/${i}`,
  }));
  const args = {
    me: players[0], party: { code: 'ABCDEF', phase: 'guessing', version: 1 },
    snapshot: { players, photos, guesses: [] }, storage: { url: (key) => key }, now: 0,
  };
  const state = buildState(args).state;
  const mine = state.views['player-0'];
  const added = state.views['player-1'];
  assert.notDeepEqual(mine.santas.map((santa) => santa.id), added.santas.map((santa) => santa.id));
  assert.deepEqual(mine.santas.map((santa) => santa.id), buildState(args).state.views['player-0'].santas.map((santa) => santa.id));
  assert.equal(mine.santas.filter((santa) => santa.isMine).length, 1);
  assert.ok(mine.santas.every((santa) => !santa.faceUrl && !santa.playerId));
  assert.ok(added.santas.every((santa) => santa.faceUrl && santa.playerId));
});

test('final badges compare complete guessing speeds and reward accurate guesses and tricky Santas', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({
    id, name: id, is_host: id === 'A', added_by: id === 'D' ? 'A' : null, revealed_at: new Date(),
  }));
  const photos = ['A', 'B', 'C'].map((id) => ({
    id: `photo-${id}`, player_id: id, eyes_key: `eyes/${id}`, face_key: `faces/${id}`,
  }));
  const guess = (guesser, photo, choice, seconds) => ({
    guesser_id: guesser, photo_id: `photo-${photo}`, guessed_player_id: choice,
    created_at: new Date(seconds * 1000),
  });
  const guesses = [
    guess('A', 'B', 'B', 0), guess('A', 'C', 'C', 10),
    guess('B', 'A', 'C', 0), guess('B', 'C', 'C', 20),
    guess('C', 'A', 'B', 0), guess('C', 'B', 'A', 10),
    guess('D', 'A', 'C', 0), guess('D', 'B', 'B', 1),
  ];
  const args = { me: players[0], party: { code: 'ABCDEF', phase: 'reveal', version: 1 },
    snapshot: { players, photos, guesses }, storage: { url: (key) => key }, now: 0 };
  const state = buildState(args).state;
  const badges = Object.fromEntries(state.leaderboard.map((row) => [row.playerId, row.badges]));
  assert.deepEqual(badges.A, ['perfect-detective', 'fastest', 'master-of-disguise', 'sneakiest-santa']);
  assert.deepEqual(badges.B, ['slowest']);
  assert.deepEqual(badges.C, ['fastest']);
  assert.deepEqual(badges.D, [], 'incomplete players do not qualify for speed or perfect badges');
  assert.deepEqual(state.views.D.leaderboard, state.views.A.leaderboard);

  guesses.push(guess('D', 'C', 'C', 10));
  const completed = buildState(args).state.leaderboard;
  assert.ok(completed.find((row) => row.playerId === 'D').badges.includes('fastest'),
    'compare average intervals when a player has more Santas to guess');
  guesses[guesses.length - 1].created_at = undefined;
  assert.ok(!buildState(args).state.leaderboard.find((row) => row.playerId === 'D').badges.includes('fastest'),
    'missing timing data does not qualify for speed badges');

  args.party.phase = 'guessing';
  const provisional = buildState(args).state;
  assert.ok(provisional.leaderboard.every((row) => !Object.hasOwn(row, 'badges')));
  assert.ok(provisional.views.D.leaderboard.every((row) => !Object.hasOwn(row, 'badges')));
});

test('badges handle tied or insufficient results without inventing awards', () => {
  const players = ['A', 'B', 'C'].map((id) => ({
    id, name: id, is_host: id === 'A', added_by: null, revealed_at: new Date(),
  }));
  const photos = players.map(({ id }) => ({
    id: `photo-${id}`, player_id: id, eyes_key: `eyes/${id}`, face_key: `faces/${id}`,
  }));
  const guess = (guesser, photo, choice, seconds) => ({
    guesser_id: guesser, photo_id: `photo-${photo}`, guessed_player_id: choice,
    created_at: new Date(seconds * 1000),
  });
  const args = { me: players[0], party: { code: 'ABCDEF', phase: 'reveal', version: 1 },
    snapshot: { players, photos, guesses: [guess('A', 'B', 'C', 0), guess('B', 'A', 'C', 0)] },
    storage: { url: (key) => key }, now: 0 };
  let badges = Object.fromEntries(buildState(args).state.leaderboard.map((row) => [row.playerId, row.badges]));
  assert.deepEqual(badges, { A: ['sneakiest-santa'], B: ['sneakiest-santa'], C: [] });

  args.snapshot.guesses = [
    guess('A', 'B', 'B', 0), guess('A', 'C', 'C', 10),
    guess('B', 'A', 'A', 0), guess('B', 'C', 'C', 10),
  ];
  badges = Object.fromEntries(buildState(args).state.leaderboard.map((row) => [row.playerId, row.badges]));
  assert.deepEqual(badges, { A: ['perfect-detective'], B: ['perfect-detective'], C: [] },
    'equal speeds and no incorrect guesses do not produce speed or disguise badges');
});

test('new Santa submissions notify the host, persist, and retry after guessing starts', { skip }, async (t) => {
  const { call, createHost } = await serve(t);
  const { code, host, ava } = await party(call, createHost);
  t.after(() => pool.query('DELETE FROM parties WHERE code = $1', [code]));
  const hostEmail = (await call('GET', '/api/auth/session', { token: host.token })).body.user.email;
  const child = (await call('POST', `/api/parties/${code}/added-players`, {
    token: host.token, json: { name: 'Child' },
  })).body.players.find((player) => player.name === 'Child');
  await allowPhotos(call, code, host.token, child.id);
  const upload = (token, as) => call('PUT', `/api/parties/${code}/photo${as ? `?as=${as}` : ''}`, {
    token, body: photoForm(image),
  });
  const image = await photo('red');
  assert.equal((await upload(host.token)).status, 201);
  assert.deepEqual((await call('GET', `/api/parties/${code}`, { token: host.token })).body.submissions, []);
  assert.equal((await upload(ava.token)).status, 201);
  assert.equal((await upload(ava.token)).status, 201, 'replacing a photo is not a new submission');
  assert.equal((await upload(host.token, child.id)).status, 201);
  const lobby = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.deepEqual(new Set(lobby.submissions.map((entry) => entry.name)), new Set(['Ava', 'Child']));
  assert.ok(lobby.submissions.every((entry) => entry.emailStatus === 'pending'));
  assert.equal((await call('GET', `/api/parties/${code}`, { token: ava.token })).body.submissions, undefined);

  const { rows: [hostRow] } = await pool.query('SELECT account_id FROM players WHERE id = $1', [host.playerId]);
  await pool.query('UPDATE players SET account_id = NULL WHERE id = $1', [host.playerId]);
  const repository = createRepository(pool);
  assert.equal(await repository.claimSubmissionNotification({ tokenHash: randomBytes(32), leaseId: randomUUID() }), null,
    'submissions wait when the host has no email address');
  await pool.query('UPDATE players SET account_id = $2 WHERE id = $1', [host.playerId, hostRow.account_id]);

  const messages = [];
  let failAva = true;
  const worker = createNotificationWorker({
    repository, clientOrigin: 'https://example.com',
    sendGuessEmail: async () => {},
    sendSubmissionEmail: async (message) => {
      if (message.playerName === 'Ava' && failAva) throw new Error('test failure');
      messages.push(message);
    },
  });
  await worker.run();
  const pending = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.equal(pending.submissions.find((entry) => entry.name === 'Ava').emailStatus, 'retrying');
  assert.equal(pending.submissions.find((entry) => entry.name === 'Child').emailStatus, 'sent');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].email, hostEmail);
  const link = new URL(messages[0].link);
  const token = new URLSearchParams(link.hash.slice(1)).get('access');
  assert.equal(link.pathname, `/p/${code}`);
  assert.equal((await call('GET', `/api/parties/${code}/notification-access`, { token })).body.me.id, host.playerId);
  assert.equal((await call('POST', `/api/parties/${code}/start`, { token: host.token })).status, 200);
  failAva = false;
  await pool.query("UPDATE submission_notifications SET next_attempt = now() WHERE player_id = $1", [ava.playerId]);
  await worker.run();
  await worker.run();
  assert.deepEqual(messages.map((message) => message.playerName).sort(), ['Ava', 'Child']);
  const final = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.ok(final.submissions.every((entry) => entry.emailStatus === 'sent'));
});

test('guessing notifications retry and provide private party-scoped access', { skip }, async (t) => {
  const { call, createHost, signIn } = await serve(t);
  const { code, host, ava, ben } = await party(call, createHost);
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'No email' } })).status, 400);
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'Bad email', email: 'invalid' } })).status, 400);
  await pool.query('UPDATE players SET notification_email = NULL WHERE id = $1', [ava.playerId]);
  const child = (await call('POST', `/api/parties/${code}/added-players`, {
    token: ben.token, json: { name: 'Child' },
  })).body.players.find((player) => player.name === 'Child');
  for (const [player, color] of [[host, 'red'], [ben, 'blue']]) {
    assert.equal((await call('PUT', `/api/parties/${code}/photo`, {
      token: player.token, body: photoForm(await photo(color)),
    })).status, 201);
  }
  const lobby = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.equal(lobby.players.find((player) => player.id === ava.playerId).canNotify, false);
  assert.equal(lobby.players.find((player) => player.id === child.id).canNotify, true);
  assert.ok(!JSON.stringify(lobby.players).includes('ben@example.com'));
  assert.equal((await call('POST', `/api/parties/${code}/start`, { token: host.token })).status, 200);
  const queued = await pool.query('SELECT player_id FROM guess_notifications ORDER BY player_id');
  assert.deepEqual(new Set(queued.rows.map((row) => row.player_id)), new Set([host.playerId, ben.playerId]));

  const abandonedToken = randomBytes(32).toString('base64url');
  const repository = createRepository(pool);
  const abandoned = await repository.claimGuessNotification({
    tokenHash: createHash('sha256').update(abandonedToken).digest(), leaseId: randomUUID(),
  });
  assert.ok(abandoned);
  await pool.query("UPDATE guess_notifications SET lease_until = now() - interval '1 second' WHERE player_id = $1", [abandoned.player_id]);
  const messages = [];
  let failBen = true;
  const worker = createNotificationWorker({
    repository, clientOrigin: 'https://example.com',
    sendSubmissionEmail: async () => {},
    sendGuessEmail: async (message) => {
      if (message.email === 'ben@example.com' && failBen) throw new Error('test failure');
      messages.push(message);
    },
  });
  await worker.run();
  assert.equal((await call('GET', `/api/parties/${code}`, { token: abandonedToken })).body.me.id, abandoned.player_id,
    'a link sent before a worker crash remains valid after retry');
  const pending = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.equal(pending.players.find((player) => player.id === ben.playerId).notificationStatus, 'retrying');
  assert.equal(pending.players.find((player) => player.id === host.playerId).notificationStatus, 'sent');
  assert.equal(messages.length, 1);
  const hostLink = new URL(messages[0].link);
  const hostToken = new URLSearchParams(hostLink.hash.slice(1)).get('access');
  assert.equal(hostLink.pathname, `/p/${code}`);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: hostToken })).body.me.id, host.playerId);
  assert.equal((await call('GET', '/api/auth/session', { token: hostToken })).body.user, null);
  const otherHost = (await createHost({ name: 'Other host' })).body;
  assert.equal((await call('GET', `/api/parties/${otherHost.code}`, { token: hostToken })).status, 401);

  failBen = false;
  await pool.query("UPDATE guess_notifications SET next_attempt = now() WHERE player_id = $1", [ben.playerId]);
  await worker.run();
  const benToken = new URLSearchParams(new URL(messages.find((message) => message.email === 'ben@example.com').link).hash.slice(1)).get('access');
  const benState = await call('GET', `/api/parties/${code}`, { token: benToken, cookie: host.token });
  assert.equal(benState.body.me.id, ben.playerId, 'the link selects its own player even in another account session');
  assert.ok(benState.body.views[child.id], 'the link retains access to managed players');
  assert.equal((await call('GET', `/api/parties/${code}/notification-access`, {
    token: 'x'.repeat(43), cookie: host.token,
  })).status, 401, 'an account session cannot validate an invalid notification link');
  assert.equal((await call('GET', `/api/parties/${code}/notification-access`, {
    token: benToken, cookie: host.token,
  })).body.me.id, ben.playerId);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: 'x'.repeat(43) })).status, 401);
  const benAccount = await signIn('ben@example.com', [{ code, token: benToken }]);
  assert.deepEqual(benAccount.body.claimed, [code], 'a notification link can be linked after email verification');
  await worker.run();
  assert.equal(messages.length, 2, 'sent notifications are not sent again');

  const changed = await call('PUT', `/api/parties/${code}/notification-email`, {
    token: benToken, json: { email: 'new-ben@example.com' },
  });
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: benToken })).status, 401, 'changing email revokes old links');
  assert.equal((await call('GET', `/api/parties/${code}`, { token: changed.body.replacementToken })).body.me.id, ben.playerId);
  const unchanged = await call('PUT', `/api/parties/${code}/notification-email`, {
    token: changed.body.replacementToken, json: { email: 'new-ben@example.com' },
  });
  assert.equal(unchanged.body.replacementToken, undefined, 'saving the same email preserves access');
  assert.equal((await call('GET', `/api/parties/${code}`, { token: changed.body.replacementToken })).status, 200);
  await worker.run();
  assert.ok(messages.some((message) => message.email === 'new-ben@example.com'));
  assert.equal((await call('PUT', `/api/parties/${code}/notification-email`, {
    token: ava.token, json: { email: 'ava@example.com' },
  })).status, 200);
  await worker.run();
  assert.ok(messages.some((message) => message.email === 'ava@example.com'), 'late email is notified during guessing');
  await pool.query("UPDATE parties SET created_at = now() - interval '31 days' WHERE code = $1", [code]);
  assert.equal((await call('GET', `/api/parties/${code}`, { token: hostToken })).status, 401);
});

test('only the host can reopen submissions and restart notifications safely', { skip }, async (t) => {
  const { call, createHost } = await serve(t);
  const { code, host, ava } = await party(call, createHost);
  t.after(() => pool.query('DELETE FROM parties WHERE code = $1', [code]));
  const image = await photo('red');
  for (const player of [host, ava]) {
    assert.equal((await call('PUT', `/api/parties/${code}/photo`, { token: player.token, body: photoForm(image) })).status, 201);
  }
  assert.equal((await call('POST', `/api/parties/${code}/reopen-submissions`, { token: host.token })).status, 409);
  const started = await call('POST', `/api/parties/${code}/start`, { token: host.token });
  assert.equal(started.status, 200);
  assert.equal((await call('POST', `/api/parties/${code}/reopen-submissions`, { token: ava.token })).status, 403);

  const oldToken = randomBytes(32).toString('base64url');
  const leaseId = randomUUID();
  await pool.query('INSERT INTO notification_links (token_hash, player_id) VALUES ($1, $2)',
    [createHash('sha256').update(oldToken).digest(), ava.playerId]);
  await pool.query("UPDATE guess_notifications SET status = 'sending', lease_id = $2 WHERE player_id = $1", [ava.playerId, leaseId]);
  const reopened = await call('POST', `/api/parties/${code}/reopen-submissions`, { token: host.token });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.phase, 'lobby');
  assert.equal(reopened.body.players.find((player) => player.id === ava.playerId).hasPhoto, true);
  assert.notEqual(reopened.headers.get('etag'), started.headers.get('etag'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guess_notifications WHERE player_id = $1', [ava.playerId])).rows[0].n, 0);
  assert.equal((await call('GET', `/api/parties/${code}/notification-access`, { token: oldToken })).body.phase, 'lobby');
  assert.equal((await call('PUT', `/api/parties/${code}/photo`, { token: ava.token, body: photoForm(image) })).status, 201);
  const newPlayer = await call('POST', `/api/parties/${code}/players`, { json: { name: 'New', email: 'new@example.com' } });
  assert.equal(newPlayer.status, 201);

  const restarted = await call('POST', `/api/parties/${code}/start`, { token: host.token });
  assert.equal(restarted.body.phase, 'guessing');
  const partyId = (await pool.query('SELECT id FROM parties WHERE code = $1', [code])).rows[0].id;
  await createRepository(pool).finishGuessNotification({ playerId: ava.playerId, partyId, leaseId, sent: true });
  const notification = (await pool.query('SELECT status, lease_id FROM guess_notifications WHERE player_id = $1', [ava.playerId])).rows[0];
  assert.deepEqual(notification, { status: 'pending', lease_id: null }, 'an old in-flight send cannot mark a new notification as sent');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guess_notifications WHERE player_id = $1', [newPlayer.body.playerId])).rows[0].n, 1);
  const view = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const target = view.santas.find((santa) => !santa.isMine);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${target.id}`, {
    token: ava.token, json: { playerId: host.playerId },
  })).status, 200);
  const reset = await call('POST', `/api/parties/${code}/reopen-submissions`, { token: host.token });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.phase, 'lobby');
  assert.ok(reset.body.players.every((player) => player.guessCount === 0 && !player.revealed));
  assert.equal((await call('PUT', `/api/parties/${code}/photo`, { token: ava.token, body: photoForm(image) })).status, 201);
  await call('POST', `/api/parties/${code}/start`, { token: host.token });
  const replay = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  assert.ok(replay.santas.every((santa) => !santa.myGuess), 'restarted guessing has no old guesses');
});

test('reopening a fully revealed party resets guesses and managed-player reveals', { skip }, async (t) => {
  const { call, createHost } = await serve(t);
  const { code, host, ava, ben } = await party(call, createHost);
  t.after(() => pool.query('DELETE FROM parties WHERE code = $1', [code]));
  const image = await photo('green');
  for (const player of [host, ava]) await call('PUT', `/api/parties/${code}/photo`, { token: player.token, body: photoForm(image) });
  const child = (await call('POST', `/api/parties/${code}/added-players`, {
    token: host.token, json: { name: 'Child' },
  })).body.players.find((player) => player.name === 'Child');
  await call('POST', `/api/parties/${code}/start`, { token: host.token });
  const revealed = await call('POST', `/api/parties/${code}/reveal?as=${child.id}`, { token: host.token });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.players.find((player) => player.id === child.id).guessCount, 0);
  const view = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const target = view.santas.find((santa) => !santa.isMine);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${target.id}`, {
    token: ava.token, json: { playerId: host.playerId },
  })).status, 200);
  for (const player of [host, ava, ben]) {
    const result = await call('POST', `/api/parties/${code}/reveal`, { token: player.token });
    assert.equal(result.status, 200);
  }
  assert.equal((await call('GET', `/api/parties/${code}`, { token: host.token })).body.phase, 'reveal');
  const reopened = await call('POST', `/api/parties/${code}/reopen-submissions`, { token: host.token });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.phase, 'lobby');
  assert.ok(reopened.body.players.every((player) => !player.revealed && player.guessCount === 0));
  await call('POST', `/api/parties/${code}/start`, { token: host.token });
  const replay = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.equal(replay.views[child.id].revealed, false);
  assert.ok(replay.views[child.id].santas.every((santa) => !santa.faceUrl && !santa.playerId));
  assert.equal((await call('GET', `/api/parties/${code}`, { token: ava.token })).body.santas.find((santa) => santa.id === target.id).myGuess, null);
});

test('a concurrent guess cannot survive reopening submissions', { skip }, async (t) => {
  const { call, createHost } = await serve(t);
  const { code, host, ava } = await party(call, createHost);
  t.after(() => pool.query('DELETE FROM parties WHERE code = $1', [code]));
  const image = await photo('blue');
  for (const player of [host, ava]) await call('PUT', `/api/parties/${code}/photo`, { token: player.token, body: photoForm(image) });
  await call('POST', `/api/parties/${code}/start`, { token: host.token });
  const view = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const target = view.santas.find((santa) => !santa.isMine);
  const [reopen, guess] = await Promise.all([
    call('POST', `/api/parties/${code}/reopen-submissions`, { token: host.token }),
    call('PUT', `/api/parties/${code}/guesses/${target.id}`, { token: ava.token, json: { playerId: host.playerId } }),
  ]);
  assert.equal(reopen.status, 200);
  assert.ok([200, 409].includes(guess.status));
  const state = (await call('GET', `/api/parties/${code}`, { token: host.token })).body;
  assert.equal(state.phase, 'lobby');
  assert.equal(state.players.find((player) => player.id === ava.playerId).guessCount, 0);
});

test('reopening and finishing an in-flight guessing email do not deadlock', { skip }, async (t) => {
  const { call, createHost } = await serve(t);
  const { code, host, ava } = await party(call, createHost);
  t.after(() => pool.query('DELETE FROM parties WHERE code = $1', [code]));
  const image = await photo('red');
  for (const player of [host, ava]) await call('PUT', `/api/parties/${code}/photo`, { token: player.token, body: photoForm(image) });
  await call('POST', `/api/parties/${code}/start`, { token: host.token });
  const partyId = (await pool.query('SELECT id FROM parties WHERE code = $1', [code])).rows[0].id;
  const leaseId = randomUUID();
  await pool.query("UPDATE guess_notifications SET status = 'sending', lease_id = $2 WHERE player_id = $1", [ava.playerId, leaseId]);
  const client = await pool.connect();
  let finishing;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
    finishing = createRepository(pool).finishGuessNotification({ playerId: ava.playerId, partyId, leaseId, sent: true });
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const result = await pool.query(`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%parties%') AS waiting`);
      waiting = result.rows[0].waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting, 'the email completion must wait for the party lock');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query('DELETE FROM guess_notifications WHERE player_id = $1', [ava.playerId]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (finishing) await finishing;
  }
});

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
  assert.equal((await call('POST', `/api/parties/${created.body.code}/players`, { json: { name: 'Guest', email: 'guest@example.com' } })).status, 201);

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
  const guest = (await call('POST', `/api/parties/${host.code}/players`, { json: { name: 'Guest', email: 'guest@example.com' } })).body;
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
  for (const sendLoginCode of [undefined, async () => { throw new Error('Simulated SendGrid outage'); }]) {
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
  const guest = (await call('POST', `/api/parties/${code}/players`, { json: { name: 'Guest', email: 'guest@example.com' } })).body;
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
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'ava ', email: 'ava@example.com' } })).status, 409);

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
  assert.equal((await call('POST', `/api/parties/${code}/players`, { json: { name: 'Late', email: 'late@example.com' } })).status, 409);
  assert.equal((await call('PUT', `/api/parties/${code}/photo`, {
    token: ava.token, body: photoForm(await photo('pink')),
  })).status, 409);

  const guessing = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const serialized = JSON.stringify(guessing);
  assert.ok(!serialized.includes('reveals/'), 'no face URLs before reveal');
  for (const santa of guessing.santas) {
    assert.deepEqual(Object.keys(santa).sort(), ['eyesUrl', 'id', 'isMine', 'myGuess', 'number']);
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
  const { rows: [partyRow] } = await pool.query('SELECT id FROM parties WHERE code = $1', [code]);
  const snapshot = await createRepository(pool).snapshot(partyRow.id);
  assert.ok(snapshot.guesses.every((guess) => guess.created_at instanceof Date), 'snapshots include guess timestamps');

  const revealed = await call('POST', `/api/parties/${code}/reveal`, { token: host.token });
  assert.equal(revealed.body.phase, 'guessing');
  assert.equal(revealed.body.views[host.playerId].revealed, true);
  assert.ok(revealed.body.leaderboard.every((row) => !Object.hasOwn(row, 'badges')));
  const outsider = (await createHost({ name: 'Stranger' })).body;
  assert.equal((await call('GET', `/api/parties/${code}`, { token: outsider.token })).status, 401);

  const benBeforeReveal = (await call('GET', `/api/parties/${code}`, { token: ben.token })).body;
  assert.equal(benBeforeReveal.views[ben.playerId].revealed, false);
  assert.ok(!JSON.stringify(benBeforeReveal).includes('reveals/'));
  const benTarget = benBeforeReveal.santas.find((santa) => !santa.isMine);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${benTarget.id}`, {
    token: ben.token, json: { playerId: host.playerId },
  })).status, 200, 'another player can still guess after a reveal');
  const reveal = (await call('POST', `/api/parties/${code}/reveal`, { token: ben.token })).body;
  assert.equal(reveal.phase, 'guessing');
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${others[0].id}`, {
    token: ben.token, json: { playerId: host.playerId },
  })).status, 409);
  assert.equal((await call('POST', `/api/parties/${code}/reveal`, { token: ben.token })).status, 409);
  const final = (await call('POST', `/api/parties/${code}/reveal`, { token: ava.token })).body;
  assert.equal(final.phase, 'reveal');
  assert.ok(final.leaderboard.every((row) => Array.isArray(row.badges)));
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
  await call('POST', `/api/parties/${code}/players`, { json: { name: 'Cy', email: 'cy@example.com' } });
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
  assert.equal((await upload(ava.token, null, await photo('red'))).status, 201);
  assert.equal((await upload(ben.token, ben2.id, await photo('pink'))).status, 201);
  assert.equal((await call('POST', `/api/parties/${code}/start`, { token: host.token })).status, 200);

  const state = (await call('GET', `/api/parties/${code}`, { token: ava.token })).body;
  const timSanta = state.views[tim.id].santas.find((santa) => santa.isMine);
  assert.ok(timSanta);
  const other = state.views[tim.id].santas.find((santa) => !santa.isMine);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${timSanta.id}`, {
    token: ava.token, json: { playerId: tim.id },
  })).status, 200, 'Ava can guess the Santa she uploaded');
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${timSanta.id}?as=${tim.id}`, {
    token: ava.token, json: { playerId: host.playerId },
  })).status, 400, 'Tim cannot guess his own Santa');
  const avaSanta = state.santas.find((santa) => santa.isMine);
  const guessed = await call('PUT', `/api/parties/${code}/guesses/${avaSanta.id}?as=${tim.id}`, {
    token: ava.token, json: { playerId: ava.playerId },
  });
  assert.equal(guessed.status, 200, 'a managed player can guess their adder');
  const card = guessed.body.views[tim.id].santas.find((santa) => santa.id === avaSanta.id);
  assert.equal(card.myGuess, ava.playerId);
  assert.equal(guessed.body.players.find((p) => p.id === tim.id).guessCount, 1);
  assert.equal((await call('PUT', `/api/parties/${code}/guesses/${other.id}?as=${tim.id}`, {
    token: ben.token, json: { playerId: host.playerId },
  })).status, 404);

  assert.equal((await call('POST', `/api/parties/${code}/reveal?as=${tim.id}`, { token: ben.token })).status, 404);
  const revealed = (await call('POST', `/api/parties/${code}/reveal?as=${tim.id}`, { token: ava.token })).body;
  assert.equal(revealed.views[tim.id].revealed, true);
  assert.equal(revealed.views[ava.playerId].revealed, false);
  assert.ok(revealed.views[tim.id].leaderboard.some((row) => row.playerId === tim.id));
  assert.ok(revealed.views[tim.id].santas.find((santa) => santa.playerId === tim.id).faceUrl.includes('reveals/'));
  assert.equal((await call('POST', `/api/parties/${code}/reveal`, { token: ava.token })).body.views[ava.playerId].revealed, true);
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
  const guest = (await call('POST', `/api/parties/${named.code}/players`, { json: { name: 'Ava', email: 'ava@example.com' } })).body;
  await allowPhotos(call, named.code, guest.token);
  await call('PUT', `/api/parties/${named.code}/photo`, { token: guest.token, body: photoForm(await photo('blue')) });
  assert.equal((await call('POST', `/api/parties/${named.code}/start`, { token: named.token })).status, 200);
  assert.deepEqual((await call('GET', `/api/parties/${named.code}/invite`)).body, { code: named.code, name: null, open: false });
});
