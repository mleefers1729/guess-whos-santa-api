import { resolve } from 'node:path';

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (env.ENABLE_LOCAL_UPLOADS !== undefined && !['true', 'false'].includes(env.ENABLE_LOCAL_UPLOADS)) {
    throw new Error('ENABLE_LOCAL_UPLOADS must be true or false');
  }
  const enableLocalUploads = env.ENABLE_LOCAL_UPLOADS === 'true';
  if (production && enableLocalUploads) {
    throw new Error('Unmasked local uploads must not be enabled in production');
  }
  if (production && !env.ORIGIN_VERIFY_SECRET) {
    throw new Error('ORIGIN_VERIFY_SECRET is required in production');
  }
  if (production && !env.DATABASE_HOST) {
    throw new Error('DATABASE_HOST is required in production');
  }
  if (env.DATABASE_HOST) {
    for (const key of ['DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME']) {
      if (!env[key]) throw new Error(`${key} is required when DATABASE_HOST is set`);
    }
    if (production && !env.DATABASE_CA_FILE) {
      throw new Error('DATABASE_CA_FILE is required in production');
    }
  }
  if (production) {
    for (const key of ['MEDIA_BUCKET', 'REVEAL_BUCKET', 'MEDIA_KEY_PAIR_ID', 'MEDIA_PRIVATE_KEY', 'AUTH_EMAIL_FROM', 'SENDGRID_API_KEY']) {
      if (!env[key]) throw new Error(`${key} is required in production`);
    }
  }
  const clientOrigin = env.CLIENT_ORIGIN ?? 'http://localhost:5173';
  const url = new URL(clientOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== clientOrigin) {
    throw new Error('CLIENT_ORIGIN must be an exact HTTP(S) origin');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('CLIENT_ORIGIN must use HTTPS in production');
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port: positiveInteger(env.PORT, 3000, 'PORT', 65535),
    clientOrigin,
    secureCookies: production || url.protocol === 'https:',
    email: { apiKey: env.SENDGRID_API_KEY, sender: env.AUTH_EMAIL_FROM },
    enableLocalUploads,
    originVerifySecret: env.ORIGIN_VERIFY_SECRET,
    trustProxy: production ? 2 : false,
    database: env.DATABASE_HOST ? {
      host: env.DATABASE_HOST,
      port: positiveInteger(env.DATABASE_PORT, 5432, 'DATABASE_PORT', 65535),
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      database: env.DATABASE_NAME,
      caFile: env.DATABASE_CA_FILE,
    } : undefined,
    rateLimitEnabled: env.RATE_LIMIT !== 'off',
    photoRetentionDays: positiveInteger(env.PHOTO_RETENTION_DAYS, 30, 'PHOTO_RETENTION_DAYS', 365),
    media: env.MEDIA_BUCKET ? {
      kind: 's3',
      region: env.AWS_REGION ?? 'us-east-1',
      mediaBucket: env.MEDIA_BUCKET,
      revealBucket: env.REVEAL_BUCKET,
      publicOrigin: clientOrigin,
      keyPairId: env.MEDIA_KEY_PAIR_ID,
      privateKey: env.MEDIA_PRIVATE_KEY,
    } : {
      kind: 'local',
      directory: resolve(env.LOCAL_MEDIA_DIR ?? './media'),
      secret: env.LOCAL_MEDIA_SECRET,
    },
    uploadDir: resolve(env.UPLOAD_DIR ?? './uploads'),
    maxUploadBytes: positiveInteger(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
  };
}
