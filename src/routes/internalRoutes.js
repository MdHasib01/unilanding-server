import { Router } from 'express';
import { internalOnly } from '../middleware/internalOnly.js';
import { resolveHost, bustCache } from '../controllers/public/resolveController.js';

/**
 * Called by the Next.js proxy, never by a browser. Two locks: the shared
 * X-Internal-Key, and the fact that next.config.ts deliberately does NOT
 * rewrite /api/internal/* — so there is no path from the public internet.
 */
const router = Router();

router.use(internalOnly);

router.get('/resolve-host', resolveHost);
router.post('/bust-host-cache', bustCache);

export default router;
