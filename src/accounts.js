import { createHash, randomBytes, randomInt } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { defaultPartyName } from './game.js';

const DAY = 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest();
const httpError = (status, message) => Object.assign(new Error(message), { status });
const opaqueToken = () => randomBytes(32).toString('base64url');

function readCookie(req, name) {
  const value = (req.get('cookie') ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return /^[\w-]{43}$/.test(value ?? '') ? value : null;
}

function cookieSettings(secure) {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/' };
}

export function createSesMailer({ region, sender }) {
  if (!sender) return undefined;
  const client = new SESv2Client({ region });
  return async ({ email, code }) => {
    await client.send(new SendEmailCommand({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [email] },
      Content: { Simple: {
        Subject: { Data: "Your Guess Who's Santa sign-in code", Charset: 'UTF-8' },
        Body: { Text: {
          Data: `Your sign-in code is ${code}.\n\nIt expires in 10 minutes and works only in the browser that requested it. Never share this code. If you did not request it, you can ignore this email.`,
          Charset: 'UTF-8',
        } },
      } },
    }));
  };
}

export function createAccountAuth({ repository, secureCookies, rateLimitEnabled = true, sendLoginCode }) {
  const sessionName = secureCookies ? '__Host-santa-session' : 'santa-session';
  const loginName = secureCookies ? '__Host-santa-login' : 'santa-login';
  const cookie = cookieSettings(secureCookies);
  const router = express.Router();
  const limit = (count, minutes) => rateLimitEnabled ? rateLimit({
    windowMs: minutes * 60 * 1000, limit: count, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many sign-in requests. Please try again later.' },
  }) : (_req, _res, next) => next();

  async function middleware(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const token = readCookie(req, sessionName);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (token || req.path.startsWith('/auth/'))) {
      if (req.get('x-santa-request') !== '1' || req.get('sec-fetch-site') === 'cross-site') {
        throw httpError(403, 'Open this site to continue');
      }
    }
    if (token) {
      const session = await repository.findAccountSession(hash(token));
      req.account = session?.user;
      if (!session) res.clearCookie(sessionName, cookie);
      else if (session.renewed) res.cookie(sessionName, token, { ...cookie, maxAge: 90 * DAY });
    }
    next();
  }

  async function accountState(user) {
    const rows = user ? await repository.accountParties(user.id) : [];
    return {
      user: user ?? null,
      parties: rows.map((row) => ({
        code: row.code, name: row.name ?? defaultPartyName(row.host_name),
        phase: row.phase, playerId: row.player_id, isHost: row.is_host,
      })),
    };
  }

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/auth/session', async (req, res) => res.json(await accountState(req.account)));

  router.post('/auth/code', limit(10, 60), async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) {
      throw httpError(400, 'Enter a valid email address');
    }
    if (!sendLoginCode) {
      console.error('Sign-in email delivery is not configured');
      return res.status(503).json({ error: 'Sign-in email is not configured yet. Please try again later.' });
    }
    const token = opaqueToken();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const tokenHash = hash(token);
    const saved = await repository.requestLogin({ email, tokenHash, codeHash: hash(`${token}:${code}`) });
    if (!saved) throw httpError(429, 'Please wait before requesting another code. Limit: 5 per hour.');
    try {
      await sendLoginCode({ email, code });
    } catch (error) {
      await repository.cancelLogin(tokenHash);
      console.error('Sign-in email delivery failed', { name: error.name });
      return res.status(503).json({ error: 'Could not send your sign-in email. Please try again later.' });
    }
    res.cookie(loginName, token, { ...cookie, maxAge: 10 * 60 * 1000 });
    res.json({ message: 'Check your email for a six-digit code. It expires in 10 minutes.' });
  });

  router.post('/auth/verify', limit(30, 15), async (req, res) => {
    const token = readCookie(req, loginName);
    const code = req.body?.code;
    if (!token || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw httpError(400, 'Enter the six-digit code in the browser that requested it');
    }
    const values = req.body?.parties ?? [];
    if (!Array.isArray(values) || values.length > 50 || values.some((value) =>
      typeof value?.code !== 'string' || !/^[A-HJ-NP-Z2-9]{6}$/.test(value.code) ||
      typeof value?.token !== 'string' || !/^[\w-]{43}$/.test(value.token))) {
      throw httpError(400, 'Invalid saved party access');
    }
    const claims = values.map((value) => ({ code: value.code, tokenHash: hash(value.token) }))
      .sort((a, b) => a.code.localeCompare(b.code) || Buffer.compare(a.tokenHash, b.tokenHash));
    const sessionToken = opaqueToken();
    const result = await repository.verifyLogin({
      tokenHash: hash(token), codeHash: hash(`${token}:${code}`), sessionHash: hash(sessionToken), claims,
    });
    if (!result) throw httpError(400, 'That code is invalid, expired, or used. After 5 attempts, request a new code.');
    const previous = readCookie(req, sessionName);
    if (previous) await repository.deleteAccountSession(hash(previous));
    res.clearCookie(loginName, cookie);
    res.cookie(sessionName, sessionToken, { ...cookie, maxAge: 90 * DAY });
    res.json({ ...await accountState(result.user), claimed: result.claimed, rejected: result.rejected });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, sessionName);
    if (token) await repository.deleteAccountSession(hash(token));
    res.clearCookie(sessionName, cookie);
    res.clearCookie(loginName, cookie);
    res.json({ user: null, parties: [] });
  });

  return { router, middleware };
}
