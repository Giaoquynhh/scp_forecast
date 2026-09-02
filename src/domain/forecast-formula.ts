import type { BlockTotals } from './types.js';

/**
 * Công thức nghiệp vụ — hàm thuần, không chạm DB, test được bằng số liệu tay.
 *
 *   weighted = w1·B1 + w2·B2 + w3·B3
 *   perDay   = weighted / divisor        (divisor luôn là 30 theo quy ước)
 *   FC       = perDay × số ngày tháng đích
 *   MA3      = FC nhưng với trọng số đều (1/3, 1/3, 1/3)
 *
 * MA3 đi ĐÚNG đường FC đi — cùng 3 khối, cùng perDay, cùng ×daysInTarget — và chỉ
 * khác mỗi bộ trọng số. Nhờ vậy bảng đối chiếu FC vs MA3 trả lời đúng một câu:
 * trọng số lệch có hơn trọng số đều không. Trước 26/08/2026 MA3 là (B1+B2+B3)/3
 * trần trụi, bỏ hẳn bước quy ngày, nên với tháng 31 ngày nó lệch ~3% so với FC vì
 * lý do chẳng liên quan gì tới trọng số.
 */

export type Weights = readonly [number, number, number];

/** Trọng số đều — định nghĩa của MA3 dưới dạng tham số của chính công thức FC. */
export const MA3_WEIGHTS: Weights = [1 / 3, 1 / 3, 1 / 3];

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

/**
 * Baseline trung bình trượt 3 tháng, quy về tháng đích y như FC.
 *
 * Cố ý dùng CHÍNH `divisor` của FC (30) chứ không chia theo số ngày thật của từng
 * khối: 30 là xấp xỉ, nhưng baseline mà chuẩn hơn FC ở một biến khác thì so sánh
 * không còn cô lập được trọng số nữa.
 */
export function movingAverage3(
  blocks: BlockTotals,
  divisor: number,
  daysInTarget: number,
): number {
  return forecastQty(blocks, MA3_WEIGHTS, divisor, daysInTarget);
}

/**
 * Cặp đã NGỦ: 2 khối gần nhất (B1, B2) đều không bán m² nào.
 *
 * Ràng buộc nghiệp vụ: ngủ 2 tháng liền thì dự báo = 0, dù B3 còn số. Không có nó thì
 * một mã bán lần cuối cách đây 3 tháng vẫn được dự báo `0,1 × B3` và kho vẫn nhập hàng
 * cho một mã đã ngừng chạy.
 *
 * CHỈ áp cho FC, KHÔNG áp cho MA3: MA3 là baseline ngây thơ, giữ nguyên để còn chỗ đo
 * xem ràng buộc này có ích thật không. Sau khi áp, ô nào B1=B2=0 mà B3>0 sẽ thành
 * FC = 0 trong khi MA3 = B3/3 — chấm lên số bán thật của tháng đó sẽ nói ai đúng.
 *
 * Vẫn TẠO dòng (hasDemand vẫn true nhờ B3 > 0) để ô đó được chấm điểm; im lặng bỏ dòng
 * thì đúng cái ràng buộc này lại là thứ duy nhất không bao giờ bị kiểm chứng.
 */
export function isDormant(blocks: BlockTotals): boolean {
  return blocks.b1 === 0 && blocks.b2 === 0;
}

/** Cặp không bán gì trong cả 3 khối thì không tạo dòng mới. */
export function hasDemand(blocks: BlockTotals): boolean {
  return blocks.b1 + blocks.b2 + blocks.b3 > 0;
}
