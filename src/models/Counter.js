import mongoose from 'mongoose';

/**
 * Gapless per-tenant sequences (order numbers). A single atomic $inc with
 * upsert, so concurrent orders can never collide on a number.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // 'order:<tenantId>'
  seq: { type: Number, default: 0 },
});

counterSchema.statics.next = async function (key) {
  const doc = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return doc.seq;
};

export const Counter = mongoose.model('Counter', counterSchema);
export default Counter;
