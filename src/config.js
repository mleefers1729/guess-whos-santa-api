import { resolve } from 'node:path';

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

export function readConfig(env = process.env) {
  const clientOrigin = env.CLIENT_ORIGIN ?? 'http://localhost:5173';
  const url = new URL(clientOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== clientOrigin) {
    throw new Error('CLIENT_ORIGIN must be an exact HTTP(S) origin');
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port: positiveInteger(env.PORT, 3000, 'PORT', 65535),
    clientOrigin,
    uploadDir: resolve(env.UPLOAD_DIR ?? './uploads'),
    maxUploadBytes: positiveInteger(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
  };
}
