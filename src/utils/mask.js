/** Shows enough of a secret to recognise it, never enough to use it. */
export function mask(value) {
  if (value === undefined || value === null || value === '') return '';
  const s = String(value);
  if (s.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, Math.max(4, s.length - 4)))}${s.slice(-4)}`;
}

/** Sentinel the client echoes back when it is not changing a secret field. */
export const UNCHANGED = '__UNCHANGED__';
