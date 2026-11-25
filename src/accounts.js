import { createHash, randomBytes, randomInt } from 'node:crypto';
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

export function createSendGridMailer({ apiKey, sender }) {
  if (!apiKey || !sender) return undefined;
  return async ({ email, code }) => {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: sender, name: "Santa's Helpers | Guess Who's Santa" },
        subject: "Santa's helpers have your sign-in code",
        content: [{
          type: 'text/plain',
          value: `Ho ho hello!\n\nSanta's helpers have a little something for you: your Guess Who's Santa sign-in code.\n\n${code}\n\nEnter this code in the browser where you requested it to get back to the merry-making. It expires in 10 minutes and works only in that browser.\n\nKeep this code under your hat. Never share it, even with someone claiming to be Santa's helpers. If you did not request it, you can safely ignore this email.\n\nStay merry,\nSanta's Helpers\nGuess Who's Santa?\nhttps://guesswhossanta.com`,
        }, {
          type: 'text/html',
          value: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your Guess Who's Santa sign-in code</title></head>
<body style="margin:0;padding:0;background-color:#faf7ed;color:#203d32;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">A little North Pole magic for your next merry moment. Your sign-in code is inside.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf7ed;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:#fffdf6;border:1px solid #dedfd1;border-radius:20px;">
        <tr><td align="center" style="padding:28px 24px 12px;">
          <img src="https://guesswhossanta.com/icon-512.png" width="144" height="144" alt="A smiling Santa in his red hat" style="display:block;width:144px;height:144px;border:0;border-radius:24px;">
          <p style="margin:16px 0 0;color:#214e3c;font-size:18px;font-weight:bold;">Guess Who's Santa?</p>
        </td></tr>
        <tr><td align="center" style="padding:12px 24px 28px;">
          <p style="margin:0 0 12px;color:#b52d3a;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">Special delivery from the North Pole</p>
          <h1 style="margin:0 0 16px;color:#214e3c;font-size:30px;line-height:1.2;">Ho ho hello!</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Santa's helpers have a little something for you:<br>your sign-in code.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:20px 8px;background-color:#e9eddf;border:1px solid #dedfd1;border-radius:12px;">
              <p style="margin:0 0 8px;color:#214e3c;font-size:12px;font-weight:bold;text-transform:uppercase;">Your sign-in code</p>
              <p style="margin:0;color:#214e3c;font-family:'Courier New',monospace;font-size:36px;font-weight:bold;letter-spacing:6px;line-height:1.3;">${code}</p>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;font-size:16px;line-height:1.6;">Enter this code in the browser where you requested it to get back to the merry-making.</p>
          <p style="margin:12px 0 0;color:#5a665a;font-size:14px;line-height:1.6;">It expires in <strong>10 minutes</strong> and works only in that browser.</p>
          <p style="margin:24px 0 0;font-size:16px;line-height:1.6;">Stay merry,<br><strong>Santa's Helpers</strong></p>
        </td></tr>
        <tr><td style="padding:20px 24px;border-top:1px solid #dedfd1;">
          <p style="margin:0;color:#5a665a;font-size:12px;line-height:1.6;">Keep this code under your hat. Never share it, even with someone claiming to be Santa's helpers. If you did not request it, you can safely ignore this email.</p>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;color:#5a665a;font-size:12px;">Guess Who's Santa? &middot; Made for merry moments.</p>
    </td></tr>
  </table>
</body>
</html>`,
        }],
      }),
    });
    if (response.status !== 202) {
      const error = new Error(`SendGrid rejected sign-in email (HTTP ${response.status})`);
      error.name = 'SendGridDeliveryError';
      error.status = response.status;
      throw error;
    }
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
      console.error('Sign-in email delivery failed', { name: error.name, status: error.status });
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
