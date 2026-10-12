import { existsSync } from 'node:fs';
import { join } from 'node:path';
import multer from 'multer';

import { Tenant } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok, created } from '../../utils/respond.js';
import { AppError, notFoundError } from '../../utils/AppError.js';
import {
  storeImage,
  IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  UPLOAD_ROOT,
} from '../../services/mediaService.js';

/**
 * Memory storage: the buffer is sniffed before anything touches disk or
 * Cloudinary, and nothing half-written is left behind on a rejected file.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    cb(new AppError('Only JPG, PNG, WEBP, GIF or SVG images can be uploaded', 415, 'UNSUPPORTED_MEDIA'));
  },
});

/** Wraps multer so its errors become our envelope instead of an HTML 500. */
export const receiveImage = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Images must be 10 MB or smaller' : err.message;
      return next(new AppError(msg, 413, 'UPLOAD_REJECTED'));
    }
    next(err);
  });

const serialise = (a) => ({
  id: a._id,
  url: a.secureUrl || a.url,
  publicId: a.publicId,
  width: a.width,
  height: a.height,
  bytes: a.bytes,
  format: a.format,
  originalFilename: a.originalFilename,
  createdAt: a.createdAt,
});

export const uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Choose an image to upload', 400, 'NO_FILE');

  const stored = await storeImage({ tenant: req.tenant, file: req.file });
  const asset = await req.db.MediaAsset.create({
    ...stored,
    resourceType: 'image',
    originalFilename: String(req.file.originalname || '').slice(0, 200),
    alt: String(req.body?.alt || '').slice(0, 300),
    uploadedBy: req.user._id,
  });

  // Display figure only; enforceLimit counts the real total.
  await Tenant.updateOne({ _id: req.tenantId }, { $inc: { 'usage.mediaBytes': stored.bytes || 0 } });

  return created(res, serialise(asset));
});

export const listMedia = asyncHandler(async (req, res) => {
  const assets = await req.db.MediaAsset.find({ resourceType: 'image' })
    .sort({ createdAt: -1 })
    .limit(80);
  return ok(res, assets.map(serialise));
});

const FILE_RE = /^[A-Za-z0-9_-]+\.(jpg|png|webp|gif|svg)$/;
const ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Serves a locally stored upload. Public by design — these are landing-page
 * images — but locked down: fixed filename shape (no traversal), nosniff, and
 * a sandboxing CSP so an SVG opened directly cannot run script on the
 * tenant's domain.
 */
export const serveLocalMedia = (req, res, next) => {
  const { tenantId, file } = req.params;
  if (!ID_RE.test(tenantId) || !FILE_RE.test(file)) return next(notFoundError());

  const full = join(UPLOAD_ROOT, tenantId, file);
  if (!existsSync(full)) return next(notFoundError('Image not found', 'MEDIA_NOT_FOUND'));

  res.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  return res.sendFile(full);
};
