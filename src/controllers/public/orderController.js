import { Product, TenantSettings, Counter } from '../../models/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { created, ok } from '../../utils/respond.js';
import { forbidden, notFoundError, unprocessable } from '../../utils/AppError.js';
import { publicId as newPublicId } from '../../utils/ids.js';
import { normalizeBdPhone, maskPhone } from '../../utils/phone.js';
import { round2 } from '../../utils/money.js';
import { safeAsync } from '../../utils/safeAsync.js';
import { sendMail } from '../../services/emailService.js';
import { orderPlacedAdmin } from '../../emails/templates.js';
import { adminUrlsFor } from '../../services/tenantService.js';
import { resolvePrimaryHost } from './pageController.js';

/** Which settings.payments key enables each payment method. */
const METHOD_SETTING = {
  cod: 'cod',
  manual_bkash: 'manualBkash',
  manual_nagad: 'manualNagad',
  manual_rocket: 'manualRocket',
  bank_transfer: 'bankTransfer',
};

/** Methods that are worthless to the tenant without a transaction id. */
const NEEDS_TRX = new Set(['manual_bkash', 'manual_nagad', 'manual_rocket']);

/**
 * Same rule the client uses for display. Matches the English label and the
 * Bengali spelling so "Dhaka" and "ঢাকা" both count as inside.
 */
function isInsideDelivery(district, insideLabel = 'Dhaka') {
  const d = String(district || '').trim().toLowerCase();
  if (!d) return false;
  const label = String(insideLabel || 'Dhaka').trim().toLowerCase();
  return d === label || (label === 'dhaka' && d === 'ঢাকা');
}

/**
 * Places an order from a landing page.
 *
 * The browser's numbers are display values only. Every line is priced from
 * the Product catalogue (Product.resolvePrice) and the delivery charge from
 * the tenant's own settings, so a tampered request body cannot change what is
 * stored.
 */
export const createOrder = asyncHandler(async (req, res) => {
  const tenant = req.tenant;
  if (!tenant.isLive()) throw forbidden('This shop is not taking orders right now', 'TENANT_NOT_LIVE');

  const body = req.body;
  const settings = await TenantSettings.getAll(tenant._id);
  const orderSettings = settings.orders;

  // ── payment method must be one the tenant actually offers ──
  const method = body.payment.method;
  const methodSetting = settings.payments?.[METHOD_SETTING[method]];
  const enabled = method === 'cod' ? methodSetting?.enabled !== false : Boolean(methodSetting?.enabled);
  if (!enabled) throw unprocessable('That payment method is not available', 'PAYMENT_METHOD_UNAVAILABLE');
  if (NEEDS_TRX.has(method) && !body.payment.transactionId) {
    throw unprocessable('A transaction ID is required for this payment method', 'TRX_REQUIRED');
  }

  if (orderSettings.requireDistrict && !body.shipping.district) {
    throw unprocessable('Please choose a district', 'DISTRICT_REQUIRED');
  }

  // ── price every line from the catalogue ──
  const items = [];
  for (const line of body.items) {
    const priced = await Product.resolvePrice(tenant._id, line.productId, line.variantId || null);
    if (!priced) throw unprocessable('A product in this order is no longer available', 'PRODUCT_UNAVAILABLE');
    items.push({
      productId: priced.product._id,
      variantId: priced.variant?._id ?? null,
      name: priced.label,
      sku: priced.sku || '',
      unitPrice: priced.unitPrice,
      qty: line.qty,
      subtotal: round2(priced.unitPrice * line.qty),
    });
  }

  const subtotal = round2(items.reduce((t, i) => t + i.subtotal, 0));
  const charges = orderSettings.deliveryCharges || {};
  let deliveryCharge = isInsideDelivery(body.shipping.district, charges.insideLabel)
    ? Number(charges.inside) || 0
    : Number(charges.outside) || 0;
  if (charges.freeAbove && subtotal >= Number(charges.freeAbove)) deliveryCharge = 0;
  const total = round2(subtotal + deliveryCharge);

  // ── identity ──
  const seq = await Counter.next(`order:${tenant._id}`);
  const prefix = String(orderSettings.orderNumberPrefix || 'UL').slice(0, 8);
  const orderNumber = `${prefix}-${String(seq).padStart(5, '0')}`;

  // Which page took the order: the home page unless the client says otherwise
  // and that page really belongs to this tenant.
  let landingPageId = null;
  if (body.landingPageId) {
    const page = await req.db.LandingPage.findById(body.landingPageId).select('_id');
    landingPageId = page?._id ?? null;
  }
  if (!landingPageId) {
    const home = await req.db.LandingPage.findOne({ isHome: true }).select('_id');
    landingPageId = home?._id ?? null;
  }

  const attribution = body.marketing?.attribution || {};
  // Attribution is whatever the browser captured; keep only bounded strings.
  const txt = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
  const order = await req.db.Order.create({
    orderNumber,
    publicId: newPublicId(),
    landingPageId,
    locale: tenant.enabledLocales.includes(body.locale) ? body.locale : tenant.defaultLocale,
    customer: {
      name: body.customer.name,
      phone: normalizeBdPhone(body.customer.phone),
      altPhone: body.customer.altPhone ? normalizeBdPhone(body.customer.altPhone) : '',
      email: body.customer.email || '',
    },
    shipping: {
      district: body.shipping.district || '',
      thana: body.shipping.thana || '',
      address: body.shipping.address,
      note: body.shipping.note || '',
    },
    items,
    pricing: { subtotal, deliveryCharge, discount: 0, total, currency: tenant.currency || 'BDT' },
    payment: {
      method,
      status: 'due',
      transactionId: body.payment.transactionId || '',
    },
    status: 'pending',
    statusHistory: [{ status: 'pending', note: 'Placed from the landing page' }],
    source: 'web',
    client: {
      ip: req.ip || '',
      userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
      pageUrl: String(body.pageUrl || '').slice(0, 1000),
      referer: String(req.headers.referer || '').slice(0, 1000),
    },
    marketing: {
      fbp: body.marketing?.fbp || '',
      fbc: body.marketing?.fbc || '',
      attribution: {
        fbclid: txt(attribution.fbclid),
        gclid: txt(attribution.gclid),
        gbraid: txt(attribution.gbraid),
        wbraid: txt(attribution.wbraid),
        ttclid: txt(attribution.ttclid),
        msclkid: txt(attribution.msclkid),
        utmSource: txt(attribution.utmSource),
        utmMedium: txt(attribution.utmMedium),
        utmCampaign: txt(attribution.utmCampaign),
        utmTerm: txt(attribution.utmTerm),
        utmContent: txt(attribution.utmContent),
        referrer: txt(attribution.referrer),
        landingUrl: txt(attribution.landingUrl),
        landingPath: txt(attribution.landingPath),
        firstSeenAt: Number.isNaN(Date.parse(txt(attribution.firstSeenAt))) ? null : new Date(txt(attribution.firstSeenAt)),
      },
    },
  });

  // Tell the shop. Fire-and-forget: an SMTP outage must never lose an order.
  if (settings.notifications?.emailOnNewOrder !== false) {
    const recipients = [
      ...(settings.email?.adminRecipients || []),
      tenant.contact?.email,
    ].filter(Boolean);
    if (recipients.length) {
      safeAsync(
        async () => {
          const host = await resolvePrimaryHost(tenant);
          const [adminUrl] = adminUrlsFor(tenant, host);
          const mail = orderPlacedAdmin({ order, tenant, adminUrl, locale: tenant.defaultLocale });
          return sendMail({ to: recipients.join(','), ...mail }, { emailSettings: settings.email });
        },
        { kind: 'email.orderPlacedAdmin', tenantId: String(tenant._id) }
      );
    }
  }

  return created(res, {
    publicId: order.publicId,
    orderNumber: order.orderNumber,
    total: order.pricing.total,
    currency: order.pricing.currency,
  });
});

/**
 * The thank-you page's summary. The publicId is a 14-character nanoid, so this
 * cannot be walked; even so the phone number is masked.
 */
export const getOrderSummary = asyncHandler(async (req, res) => {
  const order = await req.db.Order.findOne({ publicId: req.params.publicId });
  if (!order) throw notFoundError('Order not found', 'ORDER_NOT_FOUND');

  res.set('Cache-Control', 'no-store');
  return ok(res, {
    orderNumber: order.orderNumber,
    publicId: order.publicId,
    status: order.status,
    createdAt: order.createdAt,
    customer: { name: order.customer.name, phone: maskPhone(order.customer.phone) },
    shipping: {
      district: order.shipping.district,
      thana: order.shipping.thana,
      address: order.shipping.address,
    },
    items: order.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, subtotal: i.subtotal })),
    pricing: order.pricing,
    payment: { method: order.payment.method, status: order.payment.status },
  });
});

export { isInsideDelivery };
