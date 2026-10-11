import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';

/** A Cloudinary object owned by one tenant, in that tenant's folder. */
const mediaAssetSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true },
    url: { type: String, default: '' },
    secureUrl: { type: String, default: '' },
    folder: { type: String, default: '' },
    resourceType: { type: String, enum: ['image', 'video', 'raw'], default: 'image' },
    format: { type: String, default: '' },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, default: 0 },
    originalFilename: { type: String, default: '' },
    alt: { type: String, default: '' },
    tags: { type: [String], default: [] },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

mediaAssetSchema.plugin(tenantScope, { modelName: 'MediaAsset' });
mediaAssetSchema.index({ tenantId: 1, createdAt: -1 });
mediaAssetSchema.index({ tenantId: 1, publicId: 1 }, { unique: true });

export const MediaAsset = mongoose.model('MediaAsset', mediaAssetSchema);
export default MediaAsset;
