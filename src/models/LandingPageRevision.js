import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';

/** A published snapshot, for rollback. Last 20 per page are kept. */
const revisionSchema = new mongoose.Schema(
  {
    pageId: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage', required: true },
    revision: { type: Number, required: true },
    label: { type: String, default: '' },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

revisionSchema.plugin(tenantScope, { modelName: 'LandingPageRevision' });
revisionSchema.index({ tenantId: 1, pageId: 1, revision: -1 });

export const LandingPageRevision = mongoose.model('LandingPageRevision', revisionSchema);
export default LandingPageRevision;
