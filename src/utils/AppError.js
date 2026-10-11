/**
 * An error with an intended HTTP status and a stable machine-readable code.
 * Anything thrown that is NOT an AppError is treated as a 500 by the error
 * handler and its message is never sent to the client.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = undefined, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expected = true; // distinguishes "we meant this" from a crash
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (m, code, d) => new AppError(m, 400, code, d);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(m, 401, code);
export const forbidden = (m = 'Not permitted', code = 'FORBIDDEN') => new AppError(m, 403, code);
export const notFoundError = (m = 'Not found', code = 'NOT_FOUND') => new AppError(m, 404, code);
export const conflict = (m, code = 'CONFLICT', d) => new AppError(m, 409, code, d);
export const unprocessable = (m, code = 'UNPROCESSABLE', d) => new AppError(m, 422, code, d);
export const tooMany = (m = 'Too many requests', code = 'RATE_LIMITED') => new AppError(m, 429, code);
