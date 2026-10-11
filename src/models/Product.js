import mongoose from 'mongoose';
import { tenantScope } from './plugins/tenantScope.js';
import { round2 } from '../utils/money.js';

const imageRef = {
  url: { type: String, default: '' },
  publicId: { type: String, default: '' },
};

/**
 * Variants are embedded, not a separate collection: they are always read with
 * the parent product and never queried on their own.
 */
const variantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nameEn: { type: String, default: '', trim: true },
  sku: { type: String, default: '', trim: true },
  price: { type: Number, required: true, min: 0 },
  offerPrice: { type: Number, default: null, min: 0 },
  weight: { type: String, default: '' },
  image: imageRef,
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  stockQty: { type: Number, default: 0 },
});

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Product name is required'], trim: true },
    nameEn: { type: String, default: '', trim: true },
    slug: { type: String, default: '', lowercase: true, trim: true },
    sku: { type: String, default: '', trim: true },
    description: { type: String, default: '' },
    image: imageRef,
    gallery: { type: [imageRef], default: [] },

    basePrice: { type: Number, required: [true, 'Price is required'], min: 0 },
    offerPrice: { type: Number, default: null, min: 0 },
    weight: { type: String, default: '' },
    unit: { type: String, default: 'pcs' },
    invoiceCode: { type: String, default: '' },
    tag: { type: String, default: '' },

    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    stock: {
      track: { type: Boolean, default: false },
      qty: { type: Number, default: 0 },
    },

    variants: { type: [variantSchema], default: [] },
  },
  { timestamps: true }
);

productSchema.plugin(tenantScope, { modelName: 'Product' });

productSchema.index({ tenantId: 1, active: 1, sortOrder: 1 });
productSchema.index({ tenantId: 1, slug: 1 }, { unique: true, sparse: true });

/**
 * THE price authority. The browser's posted price is a display value only;
 * every order line is priced from here. Carried over from the reference's best
 * security habit (orderController.createOrder).
 */
productSchema.statics.resolvePrice = async function (tenantId, productId, variantId = null) {
  const product = await this.findOne({ tenantId, _id: productId, active: true });
  if (!product) return null;

  let listPrice = product.basePrice;
  let salePrice = product.offerPrice ?? product.basePrice;
  let label = product.name;
  let sku = product.sku;
  let variant = null;

  if (variantId) {
    variant = product.variants.id(variantId);
    if (!variant || !variant.active) return null;
    listPrice = variant.price;
    salePrice = variant.offerPrice ?? variant.price;
    label = `${product.name} — ${variant.name}`;
    sku = variant.sku || product.sku;
  }

  return {
    product,
    variant,
    label,
    sku,
    listPrice: round2(listPrice),
    unitPrice: round2(Math.min(salePrice, listPrice)),
  };
};

export const Product = mongoose.model('Product', productSchema);
export default Product;
