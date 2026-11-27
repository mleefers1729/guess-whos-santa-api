import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

const ADMIN_EMAIL = 'mitchell.leefers@gmail.com';

export function createMonitorRouter({ repository, secureCookies, rateLimitEnabled }) {
  const router = express.Router();
  const cookieName = secureCookies ? '__Host-santa-visitor' : 'santa-visitor';
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 };
  const visitLimit = rateLimitEnabled ? rateLimit({
    windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many visits; try again later' },
  }) : (_req, _res, next) => next();
  const adLimit = rateLimitEnabled ? rateLimit({
    windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many ad events; try again later' },
  }) : (_req, _res, next) => next();

  router.post('/monitor/visit', visitLimit, async (req, res) => {
    if (req.get('x-santa-request') !== '1' || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Open this site to continue' });
    }
    const value = (req.get('cookie') ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const token = /^[\w-]{43}$/.test(value ?? '') ? value : randomBytes(32).toString('base64url');
    await repository.recordVisit(createHash('sha256').update(token).digest());
    res.cookie(cookieName, token, cookieOptions);
    res.status(204).end();
  });

  router.post('/monitor/ad-events', adLimit, async (req, res) => {
    if (req.get('x-santa-request') !== '1' || req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Open this site to continue' });
    }
    const { placement, event, destination } = req.body ?? {};
    if (!['home', 'lobby', 'guessing', 'results'].includes(placement)
      || !['impression', 'click'].includes(event)
      || (event === 'click' ? !['ios', 'android', 'website'].includes(destination) : destination !== undefined)) {
      return res.status(400).json({ error: 'Invalid ad event' });
    }
    await repository.recordAdEvent({ placement, event });
    res.status(204).end();
  });

  router.get('/monitor/stats', async (req, res) => {
    if (!req.account) return res.status(401).json({ error: 'Sign in to view the dashboard' });
    if (req.account.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'This account cannot view the dashboard' });
    res.json(await repository.monitorStats());
  });

  return router;
}
