import mongoose from 'mongoose';

/**
 * Deliberately NOT tenant-scoped by the plugin: tenantId is null for platform
 * actions, and the platform must be able to read across tenants.
 */
const auditLogSchema = new mongoose.Schema(
  {
    // Covered by the { tenantId, createdAt } compound index below.
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: '' },
    actorScope: { type: String, default: '' },
    actorIp: { type: String, default: '' },
    action: { type: String, required: true },
    targetType: { type: String, default: '' },
    targetId: { type: String, default: '' },
    /** Secret paths are redacted before this is written. */
    diff: { type: mongoose.Schema.Types.Mixed, default: null },
    userAgent: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;
