import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';
import { logger } from '../config/logger.js';
import { isProd } from '../config/env.js';

export function notFound(req, _res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND'));
}

/**
 * Single exit point for every failure. Translates the error shapes we actually
 * produce into the standard envelope, and refuses to leak an unexpected
 * error's message in production.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.statusCode || 500;
  let code = err.code;
  let message = err.message || 'Internal server error';
  // AppError carries its own details (e.g. which field failed validation,
  // or the plan limit that was hit). Seed from it, then let the branches
  // below override for error shapes we translate ourselves.
  let details = err.details;

  if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_FAILED';
    message = 'Request validation failed';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 422;
    code = 'VALIDATION_FAILED';
    message = 'Document validation failed';
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid value for ${err.path}`;
  } else if (err?.code === 11000) {
    // Duplicate key. The index name tells the client which constraint bit.
    status = 409;
    code = 'DUPLICATE';
    const field = Object.keys(err.keyPattern || {}).join(', ') || 'value';
    message = `A record with that ${field} already exists`;
  }

  const log = { status, code, tenantId: req.tenantId, userId: req.user?._id, path: req.originalUrl };

  if (status >= 500) {
    logger.error({ ...log, err: { message: err.message, stack: err.stack } }, 'request failed');
    if (isProd && !(err instanceof AppError)) {
      message = 'Internal server error';
      code = 'INTERNAL';
      details = undefined;
    }
  } else {
    logger.warn(log, message);
  }

  res.status(status).json({
    success: false,
    error: message,
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
  });
}
