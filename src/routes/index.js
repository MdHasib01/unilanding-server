import { Router } from 'express';
import authRoutes from './authRoutes.js';
import platformRoutes from './platformRoutes.js';
import internalRoutes from './internalRoutes.js';
import publicRoutes from './publicRoutes.js';
import tenantRoutes from './tenantRoutes.js';
import { serveLocalMedia } from '../controllers/tenant/mediaController.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/platform', platformRoutes);
router.use('/internal', internalRoutes);
router.use('/public', publicRoutes);
router.use('/t', tenantRoutes);

// Locally stored uploads (when Cloudinary is not configured).
router.get('/media/:tenantId/:file', serveLocalMedia);

export default router;
