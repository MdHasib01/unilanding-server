import { Router } from 'express';

const router = Router();

// Route groups are mounted here as each phase lands:
//   /auth      authRoutes       (Phase 2)
//   /platform  platformRoutes   (Phase 4)
//   /t         tenantRoutes     (Phase 7)
//   /public    publicRoutes     (Phase 6)
//   /internal  internalRoutes   (Phase 5)

export default router;
