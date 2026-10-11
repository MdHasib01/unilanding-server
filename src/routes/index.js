import { Router } from 'express';
import authRoutes from './authRoutes.js';
import platformRoutes from './platformRoutes.js';
import internalRoutes from './internalRoutes.js';
import publicRoutes from './publicRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/platform', platformRoutes);
router.use('/internal', internalRoutes);
router.use('/public', publicRoutes);

// Mounted as each phase lands:
//   /t  tenantRoutes

export default router;
