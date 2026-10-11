/** Money is stored as a Number in minor-unit-free form (BDT has no practical
 *  subunit in this market). Rounded to 2dp to keep float drift out of totals. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const sum = (items, pick) => round2(items.reduce((t, i) => t + (Number(pick(i)) || 0), 0));
