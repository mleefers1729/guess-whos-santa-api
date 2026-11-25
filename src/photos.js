import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import sharp from 'sharp';

// Must match the Santa SVG in the frontend (viewBox 0 0 400 440, eye window rect).
export const SANTA = { width: 400, height: 440, eyes: { x: 95, y: 185, width: 210, height: 48 } };
export const ALIGNMENT_LIMITS = { x: [-300, 300], y: [-360, 360], zoom: [1, 4] };
const EYES_SCALE = 2;
const SKIN = '#f7cfad';
const formats = new Map([['image/jpeg', 'jpeg'], ['image/png', 'png'], ['image/webp', 'webp']]);

export class ImageError extends Error {}

export function parseAlignment(fields) {
  const alignment = {};
  for (const [key, [min, max]] of Object.entries(ALIGNMENT_LIMITS)) {
    const value = Number(fields[key] ?? (key === 'zoom' ? 1 : 0));
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new ImageError(`${key} must be between ${min} and ${max}`);
    }
    alignment[key] = value;
  }
  return alignment;
}

/**
 * Produces the two stored artifacts:
 * - eyes: only the pixels visible through the Santa eye window (safe to show before reveal)
 * - face: the full photo for the reveal, auto-rotated, resized, with metadata stripped
 */
export async function processPhoto(buffer, mimetype, alignment) {
  let oriented;
  try {
    const image = sharp(buffer, { limitInputPixels: 20_000_000 });
    const metadata = await image.metadata();
    if (metadata.format !== formats.get(mimetype) || (metadata.pages ?? 1) > 1) throw new Error();
    oriented = await image.rotate().toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageError('The photo must be a valid, single-frame JPEG, PNG, or WebP image of at most 20 megapixels');
  }
  const { width, height } = oriented.info;
  const [face, eyes] = await Promise.all([
    sharp(oriented.data).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer(),
    eyeStrip(oriented.data, width, height, alignment),
  ]);
  return { face, eyes };
}

// Mirrors <image preserveAspectRatio="xMidYMid slice"> placement in Santa.jsx.
async function eyeStrip(data, width, height, { x, y, zoom }) {
  const { eyes } = SANTA;
  const scale = Math.max((SANTA.width * zoom) / width, (SANTA.height * zoom) / height);
  const left = SANTA.width / 2 + x - (width * scale) / 2;
  const top = SANTA.height / 2 + y - (height * scale) / 2;
  const outWidth = eyes.width * EYES_SCALE;
  const outHeight = eyes.height * EYES_SCALE;
  const canvas = sharp({ create: { width: outWidth, height: outHeight, channels: 3, background: SKIN } });

  const visible = {
    x0: Math.max(eyes.x, left), y0: Math.max(eyes.y, top),
    x1: Math.min(eyes.x + eyes.width, left + width * scale),
    y1: Math.min(eyes.y + eyes.height, top + height * scale),
  };
  const sourceLeft = Math.max(0, Math.floor((visible.x0 - left) / scale));
  const sourceTop = Math.max(0, Math.floor((visible.y0 - top) / scale));
  const sourceWidth = Math.min(width - sourceLeft, Math.ceil((visible.x1 - visible.x0) / scale));
  const sourceHeight = Math.min(height - sourceTop, Math.ceil((visible.y1 - visible.y0) / scale));
  const destLeft = Math.round((visible.x0 - eyes.x) * EYES_SCALE);
  const destTop = Math.round((visible.y0 - eyes.y) * EYES_SCALE);
  const destWidth = Math.min(outWidth - destLeft, Math.round((visible.x1 - visible.x0) * EYES_SCALE));
  const destHeight = Math.min(outHeight - destTop, Math.round((visible.y1 - visible.y0) * EYES_SCALE));
  if (sourceWidth < 1 || sourceHeight < 1 || destWidth < 1 || destHeight < 1) {
    return canvas.webp({ quality: 85 }).toBuffer();
  }
  const piece = await sharp(data)
    .extract({ left: sourceLeft, top: sourceTop, width: sourceWidth, height: sourceHeight })
    .resize({ width: destWidth, height: destHeight, fit: 'fill' })
    .toBuffer();
  return canvas.composite([{ input: piece, left: destLeft, top: destTop }]).webp({ quality: 85 }).toBuffer();
}

export function photoKeys(partyId, photoId) {
  return {
    eyesKey: `media/${partyId}/${photoId}.webp`,
    faceKey: `reveals/${partyId}/${photoId}.webp`,
  };
}

export function createS3Storage({ region, mediaBucket, revealBucket, publicOrigin, keyPairId, privateKey }) {
  const s3 = new S3Client({ region });
  const bucketFor = (key) => (key.startsWith('reveals/') ? revealBucket : mediaBucket);
  return {
    async put(key, body) {
      await s3.send(new PutObjectCommand({
        Bucket: bucketFor(key), Key: key, Body: body, ContentType: 'image/webp',
        CacheControl: 'private, max-age=3600',
      }));
    },
    async remove(keys) {
      for (const bucket of new Set(keys.map(bucketFor))) {
        const objects = keys.filter((key) => bucketFor(key) === bucket).map((Key) => ({ Key }));
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      }
    },
    url(key, expiresAt) {
      return getSignedUrl({
        url: `${publicOrigin}/${key}`, keyPairId, privateKey, dateLessThan: expiresAt.toISOString(),
      });
    },
  };
}

// Local development/test storage that mimics signed CloudFront URLs via an HMAC.
export function createLocalStorage({ directory, secret }) {
  const pathFor = (key) => {
    const path = normalize(join(directory, key));
    if (!path.startsWith(normalize(directory) + sep)) throw new Error('Invalid media key');
    return path;
  };
  const sign = (key, expires) => createHmac('sha256', secret).update(`${key}\n${expires}`).digest('base64url');
  return {
    async put(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, body, { mode: 0o600 });
    },
    async remove(keys) {
      await Promise.all(keys.map((key) => rm(pathFor(key), { force: true })));
    },
    url(key, expiresAt) {
      const expires = Math.floor(expiresAt.getTime() / 1000);
      return `/api/local-media/${key}?expires=${expires}&signature=${sign(key, expires)}`;
    },
    async read(key, { expires, signature }) {
      const expected = Buffer.from(sign(key, expires));
      const actual = Buffer.from(String(signature ?? ''));
      if (!(Number(expires) * 1000 > Date.now()) || expected.length !== actual.length
        || !timingSafeEqual(expected, actual)) {
        return undefined;
      }
      return readFile(pathFor(key)).catch(() => undefined);
    },
  };
}
