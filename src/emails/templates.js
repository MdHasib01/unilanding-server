/**
 * Email bodies as plain functions returning { subject, html, text }, in the
 * recipient's locale. No template engine: these are few, and inline HTML keeps
 * the content next to the copy decisions.
 *
 * Email clients ignore most CSS, so everything is inline styles and tables.
 */

const shell = (title, bodyHtml, footer = '') => `
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Hind Siliguri',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e6e8eb;overflow:hidden;">
        <tr><td style="padding:24px 28px 8px;">
          <div style="font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">UniLanding</div>
          <h1 style="margin:10px 0 0;font-size:20px;line-height:1.35;color:#111827;">${title}</h1>
        </td></tr>
        <tr><td style="padding:12px 28px 24px;font-size:15px;line-height:1.6;color:#374151;">${bodyHtml}</td></tr>
      </table>
      ${footer ? `<div style="max-width:560px;margin:14px auto 0;font-size:12px;line-height:1.5;color:#9ca3af;text-align:center;">${footer}</div>` : ''}
    </td></tr>
  </table>
</body></html>`;

const btn = (href, label, color = '#111827') =>
  `<a href="${href}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:15px;">${label}</a>`;

const kv = (rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border-collapse:collapse;">
  ${rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(
      ([k, v]) =>
        `<tr><td style="padding:7px 0;font-size:13px;color:#6b7280;width:38%;vertical-align:top;">${k}</td><td style="padding:7px 0;font-size:14px;color:#111827;font-weight:500;">${v}</td></tr>`
    )
    .join('')}
</table>`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const strip = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ───────────────────────── tenant welcome ─────────────────────────

export function tenantWelcome({ tenant, user, password, adminUrls, locale = 'bn' }) {
  const bn = locale === 'bn';
  const title = bn
    ? `${esc(tenant.name)} — আপনার ড্যাশবোর্ড তৈরি হয়েছে`
    : `${esc(tenant.name)} — your dashboard is ready`;

  const body = bn
    ? `<p>আসসালামু আলাইকুম ${esc(user.name)},</p>
       <p><strong>${esc(tenant.name)}</strong>-এর ল্যান্ডিং পেজ ও অ্যাডমিন ড্যাশবোর্ড তৈরি হয়ে গেছে। নিচের তথ্য দিয়ে লগইন করুন।</p>
       ${kv([
         ['ইমেইল', esc(user.email)],
         ['পাসওয়ার্ড', `<code style="background:#f3f4f6;padding:3px 7px;border-radius:5px;font-size:14px;">${esc(password)}</code>`],
       ])}
       <p style="margin:0 0 18px;">${btn(adminUrls[0], 'অ্যাডমিন ড্যাশবোর্ড খুলুন')}</p>
       <p style="font-size:13px;color:#6b7280;">প্রথমবার লগইন করার পর আপনাকে পাসওয়ার্ড পরিবর্তন করতে বলা হবে।</p>
       ${adminUrls[1] ? `<p style="font-size:13px;color:#6b7280;">বিকল্প লিংক: <a href="${adminUrls[1]}" style="color:#2563eb;">${esc(adminUrls[1])}</a></p>` : ''}`
    : `<p>Hi ${esc(user.name)},</p>
       <p>The landing page and admin dashboard for <strong>${esc(tenant.name)}</strong> are ready. Sign in with the details below.</p>
       ${kv([
         ['Email', esc(user.email)],
         ['Password', `<code style="background:#f3f4f6;padding:3px 7px;border-radius:5px;font-size:14px;">${esc(password)}</code>`],
       ])}
       <p style="margin:0 0 18px;">${btn(adminUrls[0], 'Open your dashboard')}</p>
       <p style="font-size:13px;color:#6b7280;">You will be asked to change this password the first time you sign in.</p>
       ${adminUrls[1] ? `<p style="font-size:13px;color:#6b7280;">Alternate link: <a href="${adminUrls[1]}" style="color:#2563eb;">${esc(adminUrls[1])}</a></p>` : ''}`;

  const html = shell(title, body, bn ? 'UniLanding — ল্যান্ডিং পেজ প্ল্যাটফর্ম' : 'UniLanding — landing page platform');
  return { subject: title, html, text: strip(body) };
}

// ───────────────────────── order placed (tenant staff) ─────────────────────────

export function orderPlacedAdmin({ order, tenant, adminUrl, locale = 'bn' }) {
  const bn = locale === 'bn';
  const title = bn
    ? `নতুন অর্ডার ${esc(order.orderNumber)} — ৳${order.pricing.total}`
    : `New order ${esc(order.orderNumber)} — ${order.pricing.currency} ${order.pricing.total}`;

  const items = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;font-size:14px;color:#111827;">${esc(i.name)} × ${i.qty}</td><td style="padding:6px 0;font-size:14px;color:#111827;text-align:right;">${i.subtotal}</td></tr>`
    )
    .join('');

  const body = `
    ${kv([
      [bn ? 'অর্ডার' : 'Order', esc(order.orderNumber)],
      [bn ? 'নাম' : 'Name', esc(order.customer.name)],
      [bn ? 'ফোন' : 'Phone', esc(order.customer.phone)],
      [bn ? 'ঠিকানা' : 'Address', esc([order.shipping.address, order.shipping.thana, order.shipping.district].filter(Boolean).join(', '))],
      [bn ? 'পেমেন্ট' : 'Payment', esc(order.payment.method)],
      [bn ? 'সোর্স' : 'Source', esc(order.client?.pageUrl || '')],
    ])}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6e8eb;margin-top:4px;">
      ${items}
      <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">${bn ? 'ডেলিভারি' : 'Delivery'}</td><td style="padding:6px 0;font-size:13px;color:#6b7280;text-align:right;">${order.pricing.deliveryCharge}</td></tr>
      <tr><td style="padding:9px 0;border-top:1px solid #e6e8eb;font-weight:700;font-size:15px;">${bn ? 'মোট' : 'Total'}</td><td style="padding:9px 0;border-top:1px solid #e6e8eb;font-weight:700;font-size:15px;text-align:right;">${order.pricing.currency} ${order.pricing.total}</td></tr>
    </table>
    <p style="margin:18px 0 0;">${btn(adminUrl, bn ? 'অর্ডার দেখুন' : 'View order')}</p>`;

  const html = shell(title, body, esc(tenant.name));
  return { subject: title, html, text: strip(body) };
}

// ───────────────────────── order confirmation (customer) ─────────────────────────

export function orderPlacedCustomer({ order, tenant, trackUrl, locale = 'bn' }) {
  const bn = locale === 'bn';
  const title = bn
    ? `আপনার অর্ডার নিশ্চিত হয়েছে — ${esc(order.orderNumber)}`
    : `Your order is confirmed — ${esc(order.orderNumber)}`;

  const body = bn
    ? `<p>ধন্যবাদ ${esc(order.customer.name)},</p>
       <p>আপনার অর্ডারটি আমরা পেয়েছি। আমাদের টিম শীঘ্রই আপনার সাথে যোগাযোগ করবে।</p>
       ${kv([
         ['অর্ডার নম্বর', esc(order.orderNumber)],
         ['মোট', `৳${order.pricing.total}`],
         ['পেমেন্ট', order.payment.method === 'cod' ? 'ক্যাশ অন ডেলিভারি' : esc(order.payment.method)],
       ])}
       <p style="margin:18px 0 0;">${btn(trackUrl, 'অর্ডার ট্র্যাক করুন')}</p>`
    : `<p>Thank you ${esc(order.customer.name)},</p>
       <p>We have received your order and will be in touch shortly.</p>
       ${kv([
         ['Order number', esc(order.orderNumber)],
         ['Total', `${order.pricing.currency} ${order.pricing.total}`],
         ['Payment', order.payment.method === 'cod' ? 'Cash on delivery' : esc(order.payment.method)],
       ])}
       <p style="margin:18px 0 0;">${btn(trackUrl, 'Track your order')}</p>`;

  const html = shell(title, body, esc(tenant.name));
  return { subject: title, html, text: strip(body) };
}

// ───────────────────────── staff invite ─────────────────────────

export function staffInvite({ tenant, user, password, loginUrl, locale = 'bn' }) {
  const bn = locale === 'bn';
  const title = bn
    ? `${esc(tenant.name)} ড্যাশবোর্ডে আপনাকে যোগ করা হয়েছে`
    : `You have been added to ${esc(tenant.name)}`;

  const body = bn
    ? `<p>${esc(user.name)},</p>
       <p><strong>${esc(tenant.name)}</strong>-এর ড্যাশবোর্ডে আপনাকে যোগ করা হয়েছে।</p>
       ${kv([['ইমেইল', esc(user.email)], ['পাসওয়ার্ড', `<code style="background:#f3f4f6;padding:3px 7px;border-radius:5px;">${esc(password)}</code>`]])}
       <p style="margin:18px 0 0;">${btn(loginUrl, 'লগইন করুন')}</p>`
    : `<p>${esc(user.name)},</p>
       <p>You have been added to the <strong>${esc(tenant.name)}</strong> dashboard.</p>
       ${kv([['Email', esc(user.email)], ['Password', `<code style="background:#f3f4f6;padding:3px 7px;border-radius:5px;">${esc(password)}</code>`]])}
       <p style="margin:18px 0 0;">${btn(loginUrl, 'Sign in')}</p>`;

  return { subject: title, html: shell(title, body), text: strip(body) };
}

// ───────────────────────── password reset ─────────────────────────

export function passwordReset({ user, resetUrl, locale = 'bn' }) {
  const bn = locale === 'bn';
  const title = bn ? 'পাসওয়ার্ড রিসেট করুন' : 'Reset your password';
  const body = bn
    ? `<p>${esc(user.name)},</p>
       <p>নিচের বাটনে ক্লিক করে নতুন পাসওয়ার্ড সেট করুন। লিংকটি ৩০ মিনিট পর কাজ করবে না।</p>
       <p style="margin:18px 0 0;">${btn(resetUrl, 'নতুন পাসওয়ার্ড সেট করুন')}</p>
       <p style="font-size:13px;color:#6b7280;margin-top:16px;">আপনি যদি এই অনুরোধ না করে থাকেন, এই ইমেইলটি মুছে ফেলুন — কিছুই পরিবর্তন হবে না।</p>`
    : `<p>${esc(user.name)},</p>
       <p>Use the button below to set a new password. The link stops working after 30 minutes.</p>
       <p style="margin:18px 0 0;">${btn(resetUrl, 'Set a new password')}</p>
       <p style="font-size:13px;color:#6b7280;margin-top:16px;">If you did not request this, delete this email — nothing will change.</p>`;

  return { subject: title, html: shell(title, body), text: strip(body) };
}

// ───────────────────────── domain verified ─────────────────────────

export function domainVerified({ tenant, host, locale = 'bn' }) {
  const bn = locale === 'bn';
  const title = bn ? `${esc(host)} এখন সক্রিয়` : `${esc(host)} is now live`;
  const body = bn
    ? `<p><strong>${esc(host)}</strong> যাচাই সম্পন্ন হয়েছে এবং আপনার ল্যান্ডিং পেজ এখন এই ডোমেইনে চালু আছে।</p>
       <p style="margin:18px 0 0;">${btn(`https://${host}`, 'সাইট দেখুন')}</p>`
    : `<p><strong>${esc(host)}</strong> has been verified and your landing page is now served on it.</p>
       <p style="margin:18px 0 0;">${btn(`https://${host}`, 'Visit site')}</p>`;

  return { subject: title, html: shell(title, body, esc(tenant.name)), text: strip(body) };
}
