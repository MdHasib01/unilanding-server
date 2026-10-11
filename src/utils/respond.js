/** The one response envelope, matching the reference so client patterns port. */
export const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });

export const created = (res, data, extra = {}) =>
  res.status(201).json({ success: true, data, ...extra });

export const okList = (res, data, pagination, extra = {}) =>
  res.json({ success: true, data, pagination, ...extra });

export const noContent = (res) => res.status(204).end();
