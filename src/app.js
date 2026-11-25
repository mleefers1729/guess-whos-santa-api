import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import { readConfig } from './config.js';
import { createGameRouter } from './game.js';
import { createAccountAuth } from './accounts.js';
import { createMonitorRouter } from './monitor.js';

const imageTypes = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function createApp(config = readConfig(), { checkDatabase, repository, storage, sendLoginCode } = {}) {
  if (config.database && !checkDatabase) {
    throw new Error('Database readiness check is required when a database is configured');
  }
  const incomingDir = join(config.uploadDir, '.incoming');
  if (config.enableLocalUploads) {
    await mkdir(config.uploadDir, { recursive: true, mode: 0o700 });
    await mkdir(incomingDir, { recursive: true, mode: 0o700 });
  }

  const upload = config.enableLocalUploads ? multer({
    storage: multer.diskStorage({
      destination: incomingDir,
      filename: (_req, _file, done) => done(null, randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, done) => {
      if (!imageTypes.has(file.mimetype)) {
        return done(requestError(415, 'Only JPEG, PNG, and WebP images are supported'));
      }
      done(null, true);
    },
  }) : undefined;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: 'guess-whos-santa-api' });
  });

  app.use((req, _res, next) => {
    if (config.originVerifySecret) {
      const expected = Buffer.from(config.originVerifySecret);
      const actual = Buffer.from(req.get('x-origin-verify') ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return next(requestError(403, 'Direct API access is not allowed'));
      }
    }
    next();
  });
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (checkDatabase) {
      try {
        await checkDatabase();
      } catch (error) {
        console.error('Database readiness check failed', error);
        return res.status(503).json({ status: 'unavailable', database: 'unavailable' });
      }
    }
    res.json({ status: 'ok', database: checkDatabase ? 'connected' : 'not-configured' });
  });

  if (storage?.read) {
    app.get('/api/local-media/*key', async (req, res) => {
      const body = await storage.read(req.params.key.join('/'), req.query);
      if (!body) throw requestError(404, 'Media not found');
      res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' }).send(body);
    });
  }
  if (repository && storage) {
    const accounts = createAccountAuth({
      repository, secureCookies: config.secureCookies, rateLimitEnabled: config.rateLimitEnabled, sendLoginCode,
    });
    app.use('/api', accounts.middleware, accounts.router);
    app.use('/api', createMonitorRouter({
      repository, secureCookies: config.secureCookies, rateLimitEnabled: config.rateLimitEnabled,
    }));
    app.use('/api', createGameRouter({
      repository, storage, maxUploadBytes: config.maxUploadBytes, rateLimitEnabled: config.rateLimitEnabled,
    }));
  }

  if (config.enableLocalUploads) app.post('/api/uploads',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many uploads; try again later' },
    }),
    upload.single('photo'),
    async (req, res) => {
      if (!req.file) {
        throw requestError(400, 'A photo file is required');
      }

      const inputPath = join(incomingDir, basename(req.file.path));
      try {
        let result;
        try {
          const image = sharp(inputPath, { limitInputPixels: 20_000_000 });
          const metadata = await image.metadata();
          if (metadata.format !== imageTypes.get(req.file.mimetype) || (metadata.pages ?? 1) > 1) {
            throw new Error('Unsupported image content');
          }
          result = await image.rotate()
            .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85 })
            .toBuffer({ resolveWithObject: true });
        } catch {
          throw requestError(422, 'The photo must contain a valid, single-frame JPEG, PNG, or WebP image of at most 20 megapixels');
        }

        const id = randomUUID();
        const destination = join(config.uploadDir, `${id}.webp`);
        try {
          await writeFile(destination, result.data, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (error.code !== 'EEXIST') await rm(destination, { force: true });
          throw error;
        }
        res.status(201).json({
          id,
          contentType: 'image/webp',
          width: result.info.width,
          height: result.info.height,
          size: result.info.size,
        });
      } finally {
        await rm(inputPath, { force: true });
      }
    });

  app.use((_req, _res, next) => next(requestError(404, 'Route not found')));
  app.use((error, _req, res, _next) => {
    let status = error.status ?? 500;
    let message = error.message;
    if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = status === 413 ? 'Photo exceeds the upload size limit' : 'Send one photo file plus alignment fields only';
    } else if (error.type === 'entity.parse.failed') {
      message = 'Invalid JSON body';
    } else if (error.type === 'entity.too.large') {
      message = 'Request body exceeds the size limit';
    }
    if (status >= 500) {
      console.error(error);
      message = 'Internal server error';
    }
    res.status(status).json({ error: message });
  });
  return app;
}
