import type { BlockTotals } from './types.js';

/**
 * Công thức nghiệp vụ — hàm thuần, không chạm DB, test được bằng số liệu tay.
 *
 *   weighted = w1·B1 + w2·B2 + w3·B3
 *   perDay   = weighted / divisor        (divisor luôn là 30 theo quy ước)
 *   FC       = perDay × số ngày tháng đích
 *   MA3      = (B1 + B2 + B3) / 3        (không trọng số, không quy theo ngày)
 */

export type Weights = readonly [number, number, number];

/** Làm tròn 2 chữ số — khớp numeric(15,2) của cột trong DB. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function weightedDemand(blocks: BlockTotals, weights: Weights): number {
  return weights[0] * blocks.b1 + weights[1] * blocks.b2 + weights[2] * blocks.b3;
}

export function perDay(weighted: number, divisor: number): number {
  if (divisor <= 0) throw new RangeError('divisor phải > 0');
  return weighted / divisor;
}

export function forecastQty(
  blocks: BlockTotals,
  weights: Weights,
  divisor: number,
  daysInTarget: number,
): number {
  if (daysInTarget <= 0) throw new RangeError('daysInTarget phải > 0');
  return round2(perDay(weightedDemand(blocks, weights), divisor) * daysInTarget);
}

/** Trung bình trượt 3 tháng. */
export function movingAverage3(blocks: BlockTotals): number {
  return round2((blocks.b1 + blocks.b2 + blocks.b3) / 3);
}

/** Cặp không bán gì trong cả 3 khối thì không tạo dòng mới. */
export function hasDemand(blocks: BlockTotals): boolean {
  return blocks.b1 + blocks.b2 + blocks.b3 > 0;
}
