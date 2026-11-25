import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { ImageError, parseAlignment, photoKeys, processPhoto } from './photos.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
// Signed photo URLs live 10-15 minutes; the ETag rolls every 5 minutes so polling clients refresh them.
const URL_TTL_MS = 15 * 60 * 1000;
const URL_BUCKET_MS = 5 * 60 * 1000;
const MIN_SANTAS = 2;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const hashToken = (token) => createHash('sha256').update(token).digest();

function newCode() {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

function newPlayer(name, isHost = false) {
  const token = randomBytes(32).toString('base64url');
  return { id: randomUUID(), name, isHost, token, tokenHash: hashToken(token) };
}

function readName(body) {
  const name = typeof body?.name === 'string' ? body.name.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 1 || name.length > 30 || /[\p{Cc}<>]/u.test(name)) {
    throw httpError(400, 'Name must be 1-30 characters');
  }
  return name;
}

const PARTY_NAME_MAX = 40;
const DEFAULT_PARTY_NAME = 'Santa party';
function readPartyName(value, { optional = false } = {}) {
  const name = typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (!name && optional) return null;
  if (name.length < 1 || name.length > PARTY_NAME_MAX || /[\p{Cc}<>]/u.test(name)) {
    throw httpError(400, `Party name must be 1-${PARTY_NAME_MAX} characters`);
  }
  return name;
}

// Unnamed parties store null; members see "<host>’s party", but the public invite never shows the host's name.
export function defaultPartyName(hostName) {
  if (!hostName) return DEFAULT_PARTY_NAME;
  const full = `${hostName}’s party`;
  return full.length <= PARTY_NAME_MAX ? full : DEFAULT_PARTY_NAME;
}

function readCode(value) {
  const code = String(value ?? '').toUpperCase();
  if (code.length !== CODE_LENGTH || [...code].some((c) => !CODE_ALPHABET.includes(c))) {
    throw httpError(404, 'Party not found');
  }
  return code;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readId(value, message) {
  if (typeof value !== 'string' || !UUID.test(value)) throw httpError(404, message);
  return value.toLowerCase();
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

// Deterministic per-party order that does not reveal join order or player ids.
function santaOrder(photos) {
  return [...photos].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildState({ me, party, snapshot, storage, now = Date.now() }) {
  const expiresAt = new Date(Math.floor(now / URL_BUCKET_MS) * URL_BUCKET_MS + URL_TTL_MS);
  const rolls = Math.floor(now / URL_BUCKET_MS);
  const photoOwner = new Map(snapshot.photos.map((photo) => [photo.id, photo.player_id]));
  const santas = santaOrder(snapshot.photos);
  // "Crew" = me plus the players I added; this device uploads and guesses for all of them.
  const crew = new Set([me.id, ...snapshot.players.filter((p) => p.added_by === me.id).map((p) => p.id)]);
  const players = snapshot.players.map((player) => {
    const photo = snapshot.photos.find((item) => item.player_id === player.id);
    return {
      id: player.id,
      name: player.name,
      isHost: player.is_host,
      addedBy: player.added_by,
      hasPhoto: Boolean(photo),
      guessCount: snapshot.guesses.filter((guess) => guess.guesser_id === player.id).length,
      ...(crew.has(player.id) && {
        eyesUrl: photo ? storage.url(photo.eyes_key, expiresAt) : null,
        mediaConsent: player.media_consent,
      }),
    };
  });
  const myPhoto = snapshot.photos.find((photo) => photo.player_id === me.id);
  const state = {
    code: party.code,
    name: party.name ?? defaultPartyName(snapshot.players.find((player) => player.is_host)?.name),
    phase: party.phase,
    version: party.version,
    me: { id: me.id, name: me.name, isHost: me.is_host, hasPhoto: Boolean(myPhoto) },
    players,
    myEyesUrl: myPhoto ? storage.url(myPhoto.eyes_key, expiresAt) : null,
  };
  if (party.phase === 'guessing') {
    const mine = new Map(snapshot.guesses.filter((g) => g.guesser_id === me.id)
      .map((g) => [g.photo_id, g.guessed_player_id]));
    state.santas = santas.map((photo, index) => ({
      id: photo.id,
      number: index + 1,
      eyesUrl: storage.url(photo.eyes_key, expiresAt),
      isMine: photo.player_id === me.id,
      myGuess: mine.get(photo.id) ?? null,
      ownerId: crew.has(photo.player_id) ? photo.player_id : null,
      guesses: Object.fromEntries(snapshot.guesses
        .filter((g) => g.photo_id === photo.id && crew.has(g.guesser_id))
        .map((g) => [g.guesser_id, g.guessed_player_id])),
    }));
  }
  if (party.phase === 'reveal') {
    const scores = new Map(snapshot.players.map((player) => [player.id, 0]));
    for (const guess of snapshot.guesses) {
      if (photoOwner.get(guess.photo_id) === guess.guessed_player_id) {
        scores.set(guess.guesser_id, scores.get(guess.guesser_id) + 1);
      }
    }
    state.santas = santas.map((photo, index) => {
      const guesses = snapshot.guesses.filter((guess) => guess.photo_id === photo.id);
      return {
        id: photo.id,
        number: index + 1,
        eyesUrl: storage.url(photo.eyes_key, expiresAt),
        faceUrl: storage.url(photo.face_key, expiresAt),
        playerId: photo.player_id,
        myGuess: guesses.find((guess) => guess.guesser_id === me.id)?.guessed_player_id ?? null,
        correctCount: guesses.filter((guess) => guess.guessed_player_id === photo.player_id).length,
        guessCount: guesses.length,
      };
    });
    state.leaderboard = players
      .map((player) => ({ playerId: player.id, name: player.name, score: scores.get(player.id) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }
  return { state, etag: `W/"${party.version}-${me.id}-${rolls}"` };
}

export function createGameRouter({ repository, storage, maxUploadBytes, rateLimitEnabled = true }) {
  const router = express.Router();
  const limiter = (limit, windowMs = 15 * 60 * 1000) => (rateLimitEnabled ? rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests; try again later' },
  }) : (_req, _res, next) => next());
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 5, parts: 6 },
    fileFilter: (_req, file, done) => done(imageTypes.has(file.mimetype)
      ? null : httpError(415, 'Only JPEG, PNG, and WebP images are supported'), imageTypes.has(file.mimetype)),
  });

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  async function authenticate(req, _res, next) {
    const code = readCode(req.params.code);
    const token = /^Bearer ([\w-]{20,100})$/.exec(req.get('authorization') ?? '')?.[1];
    let me = req.account && await repository.findAccountPlayer(code, req.account.id);
    if (!me && token) me = await repository.findPlayer(code, hashToken(token));
    if (me?.account_id && me.account_id !== req.account?.id) {
      throw httpError(401, 'Sign in to the account that saved this party');
    }
    if (!me) throw httpError(401, 'Join this party to continue');
    req.me = me;
    next();
  }

  function hostOnly(req, _res, next) {
    if (!req.me.is_host) throw httpError(403, 'Only the host can do that');
    next();
  }

  async function sendState(req, res, status = 200) {
    const party = await repository.findParty(req.me.code);
    const snapshot = await repository.snapshot(req.me.party_id);
    const { state, etag } = buildState({ me: req.me, party, snapshot, storage });
    res.set('ETag', etag);
    // Compared manually: fetch() adds Cache-Control: no-cache to conditional requests, which defeats req.fresh.
    const known = (req.get('if-none-match') ?? '').split(',').map((tag) => tag.trim());
    if (status === 200 && req.method === 'GET' && known.includes(etag)) return res.status(304).end();
    res.status(status).json(state);
  }

  router.post('/parties', limiter(20), async (req, res) => {
    if (!req.account) throw httpError(401, 'Sign in with your email to host and save your party');
    const host = newPlayer(readName(req.body), true);
    host.accountId = req.account.id;
    const name = readPartyName(req.body?.partyName, { optional: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newCode();
      try {
        await repository.createParty({ partyId: randomUUID(), code, name, host });
        return res.status(201).json({ code, name: name ?? defaultPartyName(host.name), playerId: host.id, account: true });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw httpError(503, 'Could not create a party; try again');
  });

  router.post('/parties/:code/players', limiter(60), async (req, res) => {
    const party = await repository.findParty(readCode(req.params.code));
    if (!party) throw httpError(404, 'Party not found');
    const existing = req.account && await repository.findAccountPlayer(party.code, req.account.id);
    if (existing) return res.json({ code: party.code, name: party.name, playerId: existing.id, account: true });
    const player = newPlayer(readName(req.body));
    player.accountId = req.account?.id;
    let result;
    try {
      result = await repository.addPlayer({ partyId: party.id, player });
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(409, 'Someone at this party already has that name');
      throw error;
    }
    if (result === 'closed') throw httpError(409, 'This party has already started');
    res.status(201).json({
      code: party.code, name: party.name, playerId: player.id,
      ...(req.account ? { account: true } : { token: player.token }),
    });
  });

  // Public preview for the join screen; anyone with the code can see the party name.
  router.get('/parties/:code/invite', limiter(120), async (req, res) => {
    const party = await repository.findParty(readCode(req.params.code));
    if (!party) throw httpError(404, 'Party not found');
    const open = party.phase === 'lobby';
    res.json({ code: party.code, name: open ? party.name : null, open });
  });

  router.patch('/parties/:code', limiter(30), authenticate, hostOnly, async (req, res) => {
    await repository.renameParty({ partyId: req.me.party_id, name: readPartyName(req.body?.name) });
    await sendState(req, res);
  });

  // Lets a member act for a player they added: `?as=<playerId>`.
  async function actor(req, _res, next) {
    req.actor = req.me;
    if (req.query.as !== undefined) {
      const playerId = readId(req.query.as, 'Player not found');
      if (playerId !== req.me.id) {
        const added = await repository.findAddedPlayer({ partyId: req.me.party_id, addedBy: req.me.id, playerId });
        if (!added) throw httpError(404, 'Player not found');
        req.actor = added;
      }
    }
    next();
  }

  router.get('/parties/:code', authenticate, (req, res) => sendState(req, res));

  router.post('/parties/:code/added-players', limiter(60), authenticate, async (req, res) => {
    const player = newPlayer(readName(req.body));
    let result;
    try {
      result = await repository.addPlayer({ partyId: req.me.party_id, player, addedBy: req.me.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw httpError(409, 'Someone at this party already has that name');
      // The adder was removed while this request was in flight.
      if (error?.code === '23503') throw httpError(401, 'Join this party to continue');
      throw error;
    }
    if (result === 'closed') throw httpError(409, 'Players can only be added before guessing starts');
    await sendState(req, res, 201);
  });

  router.put('/parties/:code/media-consent', limiter(60), authenticate, actor, async (req, res) => {
    const { kind, granted } = req.body ?? {};
    if (!['camera', 'photos'].includes(kind) || typeof granted !== 'boolean') {
      throw httpError(400, 'Send a camera or photos consent choice with a boolean granted value');
    }
    const result = await repository.saveMediaConsent({
      partyId: req.me.party_id, playerId: req.actor.id, kind, granted, recordedBy: req.me.id,
    });
    if (result === 'closed') throw httpError(409, 'Photo access choices are locked once guessing starts');
    if (result === 'missing') throw httpError(404, 'Player not found');
    await sendState(req, res);
  });

  router.put('/parties/:code/photo', limiter(30), authenticate, actor, upload.single('photo'), async (req, res) => {
    if (!req.file) throw httpError(400, 'A photo file is required');
    if (req.me.phase !== 'lobby') throw httpError(409, 'Photos are locked once guessing starts');
    const { source, shareConsent } = req.body ?? {};
    if (!['camera', 'photos'].includes(source) || shareConsent !== 'true') {
      throw httpError(400, 'Photo source and explicit party-sharing consent are required');
    }
    if (!req.actor.media_consent[source]?.granted) {
      throw httpError(403, 'Allow this photo source before uploading');
    }
    let processed;
    try {
      processed = await processPhoto(req.file.buffer, req.file.mimetype, parseAlignment(req.body ?? {}));
    } catch (error) {
      if (error instanceof ImageError) throw httpError(422, error.message);
      throw error;
    }
    const photo = { id: randomUUID() };
    Object.assign(photo, photoKeys(req.me.party_id, photo.id));
    await Promise.all([storage.put(photo.eyesKey, processed.eyes), storage.put(photo.faceKey, processed.face)]);
    const result = await repository.savePhoto({
      partyId: req.me.party_id, playerId: req.actor.id, photo, source, recordedBy: req.me.id,
    });
    if (result.status !== 'saved') {
      await storage.remove([photo.eyesKey, photo.faceKey]);
      if (result.status === 'consent-required') throw httpError(403, 'Allow this photo source before uploading');
      throw httpError(409, 'Photos are locked once guessing starts');
    }
    if (result.replaced) {
      await storage.remove([result.replaced.eyes_key, result.replaced.face_key]).catch(console.error);
    }
    await sendState(req, res, 201);
  });

  router.delete('/parties/:code/players/:playerId', authenticate, async (req, res) => {
    const result = await repository.removePlayer({
      partyId: req.me.party_id, playerId: readId(req.params.playerId, 'Player not found'), requester: req.me,
    });
    if (result.status === 'closed') throw httpError(409, 'Players can only be removed before guessing starts');
    if (result.status === 'missing') throw httpError(404, 'Player not found');
    if (result.status === 'host') throw httpError(400, 'The host cannot be removed');
    if (result.status === 'forbidden') throw httpError(403, 'Only the host can remove that player');
    const keys = result.photos.flatMap((photo) => [photo.eyes_key, photo.face_key]);
    if (keys.length) await storage.remove(keys).catch(console.error);
    await sendState(req, res);
  });

  router.post('/parties/:code/start', authenticate, hostOnly, async (req, res) => {
    const result = await repository.advance({
      partyId: req.me.party_id, from: 'lobby', to: 'guessing', minimumPhotos: MIN_SANTAS,
    });
    if (result === 'not-enough-photos') throw httpError(409, `At least ${MIN_SANTAS} Santas need photos to start`);
    if (result !== 'advanced') throw httpError(409, 'The game has already started');
    await sendState(req, res);
  });

  router.put('/parties/:code/guesses/:photoId', authenticate, actor, async (req, res) => {
    const guessedPlayerId = readId(req.body?.playerId, 'Pick someone else in this party');
    const result = await repository.addGuess({
      partyId: req.me.party_id, guesserId: req.actor.id,
      photoId: readId(req.params.photoId, 'Santa not found'), guessedPlayerId,
    });
    const errors = {
      closed: [409, 'Guessing is not open'],
      'missing-photo': [404, 'Santa not found'],
      'own-photo': [400, "That's you! Guess the other Santas"],
      'crew-photo': [400, 'You added that Santa! Guess the others'],
      'invalid-suspect': [400, 'Pick someone else in this party'],
      duplicate: [409, 'You already guessed this Santa'],
    };
    if (errors[result]) throw httpError(...errors[result]);
    await sendState(req, res);
  });

  router.post('/parties/:code/reveal', authenticate, hostOnly, async (req, res) => {
    const result = await repository.advance({ partyId: req.me.party_id, from: 'guessing', to: 'reveal' });
    if (result !== 'advanced') throw httpError(409, 'Reveal is only available during guessing');
    await sendState(req, res);
  });

  return router;
}
