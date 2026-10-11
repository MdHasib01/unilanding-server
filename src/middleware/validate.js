import { ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';

/**
 * validate({ body, query, params }) — each value a zod schema.
 *
 * Parsed output REPLACES the raw input, so downstream controllers see coerced,
 * stripped data and can never accidentally read an unvalidated field. This is
 * the fix for the reference codebase's hand-rolled per-controller checks, which
 * drifted from the actual request shape over time.
 */
export const validate = (schemas) => (req, _res, next) => {
  try {
    if (schemas.params) req.params = schemas.params.parse(req.params);
    if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      return next(
        new AppError(
          'Request validation failed',
          422,
          'VALIDATION_FAILED',
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
        )
      );
    }
    next(err);
  }
};
