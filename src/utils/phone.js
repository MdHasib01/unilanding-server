/** Bangladesh mobile: 11 local digits (01XXXXXXXXX) or 13 with country code. */
export const BD_PHONE_RE = /^01[3-9]\d{8}$/;

export function normalizeBdPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('880')) return digits.slice(2);
  if (digits.length === 12 && digits.startsWith('88')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('01')) return digits;
  if (digits.length === 10 && digits.startsWith('1')) return `0${digits}`;
  return digits;
}

export const isValidBdPhone = (input) => BD_PHONE_RE.test(normalizeBdPhone(input));

/** 8801XXXXXXXXX — the form SMS and Meta CAPI want. */
export const toE164Bd = (input) => {
  const local = normalizeBdPhone(input);
  return local.length === 11 ? `88${local}` : local;
};

/** Safe for logs: 017••••7890 */
export const maskPhone = (input) => {
  const p = normalizeBdPhone(input);
  return p.length < 7 ? '•'.repeat(p.length) : `${p.slice(0, 3)}••••${p.slice(-4)}`;
};
