import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * Codes are stored hashed, never in plaintext, and the document self-destructs
 * via a TTL index so an abandoned code cannot be replayed later.
 */
const otpTokenSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    codeHash: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['order_verify', 'login', 'password_reset'],
      default: 'order_verify',
    },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

otpTokenSchema.plugin(tenantScope, { modelName: 'OtpToken' });
otpTokenSchema.index({ tenantId: 1, phone: 1, purpose: 1 });

export const OtpToken = mongoose.model('OtpToken', otpTokenSchema);
export default OtpToken;
