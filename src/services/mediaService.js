import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { v2 as cloudinary } from 'cloudinary';

import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { opaqueToken } from '../utils/ids.js';

const here = dirname(fileURLToPath(import.meta.url));

/** server/uploads — outside src/, and git-ignored. */
export const UPLOAD_ROOT = join(here, '..', '..', 'uploads');

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const cloudinaryEnabled = () =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

let configured = false;
function ensureCloudinary() {
  if (configured) return;
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

/**
 * The file's real type, from its first bytes. The browser-supplied mimetype is
 * only a claim; a renamed HTML file must not be stored as an "image".
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
}

/**
 * Stores one image for a tenant and returns what a MediaAsset needs.
 *
 * Cloudinary when it is configured — CDN, resizing, nothing on our disk.
 * Otherwise local disk under uploads/<tenantId>/, served same-origin by
 * GET /api/media/:tenantId/:file, so development works with zero setup.
 */
export async function storeImage({ tenant, file }) {
  const type = sniffImageType(file.buffer);
  if (!type || !IMAGE_TYPES[type]) {
    throw new AppError('Only JPG, PNG, WEBP, GIF or SVG images can be uploaded', 415, 'UNSUPPORTED_MEDIA');
  }
  const ext = IMAGE_TYPES[type];

  if (cloudinaryEnabled()) {
    ensureCloudinary();
    const folder = `${env.CLOUDINARY_ROOT_FOLDER}/${tenant.slug}`;
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'image', overwrite: false, unique_filename: true },
        (err, out) => (err ? reject(err) : resolve(out))
      );
      stream.end(file.buffer);
    }).catch((err) => {
      throw new AppError(`Upload failed: ${err.message}`, 502, 'UPLOAD_FAILED');
    });

    return {
      publicId: result.public_id,
      url: result.secure_url,
      secureUrl: result.secure_url,
      folder,
      format: result.format || ext,
      width: result.width ?? null,
      height: result.height ?? null,
      bytes: result.bytes ?? file.size,
    };
  }

  const dir = join(UPLOAD_ROOT, String(tenant._id));
  await mkdir(dir, { recursive: true });
  const name = `${Date.now().toString(36)}-${opaqueToken().slice(0, 10)}.${ext}`;
  await writeFile(join(dir, name), file.buffer);

  const url = `/api/media/${tenant._id}/${name}`;
  return {
    publicId: `local/${tenant._id}/${name}`,
    url,
    secureUrl: url,
    folder: `local/${tenant._id}`,
    format: ext,
    width: null,
    height: null,
    bytes: file.size,
  };
}
