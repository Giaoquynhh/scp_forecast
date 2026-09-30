import { addMonths, firstOfMonth, toDateOnly } from './period.js';

/**
 * Accuracy FC vs MA3 — phần thuần (không chạm DB).
 *
 * Công thức chép từ SmartlogSCP.Backend/src/demand/forecast-learning.service.ts
 * (`flWape`). Bảng forecast_accuracy_* là bản tính sẵn của đúng phép đó, nên sửa
 * công thức thì sửa CẢ HAI chỗ — hoặc BE sẽ nói khác bảng.
 *
 *   acc = (1 − err / tt) × 100, kẹp sàn 0;  tt = 0 ⇒ err = 0 ? 100 : 0
 *
 * Bản SQL của hàm này nằm ở infra/accuracy.repository.ts (WAPE_SQL).
 */
export function wape(err: number | null, tt: number | null): number | null {
  if (err === null || tt === null) return null;
  if (tt === 0) return err === 0 ? 100 : 0;
  const acc = (1 - err / tt) * 100;
  return acc < 0 ? 0 : acc;
}

/** Tháng `period` (YYYY-MM-DD, ngày 1) đã khép chưa, tính theo giờ của `now`. */
export function isClosedMonth(period: string, now: Date): boolean {
  return period < toDateOnly(firstOfMonth(now.getFullYear(), now.getMonth()));
}

/**
 * Các tháng mà lượt cron phải xét: [tháng hiện tại − (back−1) .. tháng sau].
 *
 * 13 tháng lùi = đủ cho lựa chọn tối đa 12 tháng trên màn + 1 tháng đệm. Tháng sau
 * có dòng từ ngày cuối tháng (FC + MA3 xem trước). Chỉ tháng nào thật sự cũ mới bị
 * tính lại — xem `needsRefresh`.
 */
export function refreshWindow(now: Date, back = 13): string[] {
  const cur = firstOfMonth(now.getFullYear(), now.getMonth());
  const out: string[] = [];
  for (let i = back - 1; i >= -1; i -= 1) out.push(toDateOnly(addMonths(cur, -i)));
  return out;
}

/** Tình trạng một tháng: phía nguồn (branch_forecast) và phía bảng accuracy. */
export interface MonthState {
  period: string;
  /** Số dòng branch_forecast của tháng. */
  sourceRows: number;
  /** max(last_updated_at) của branch_forecast trong tháng. */
  sourceUpdatedAt: Date | null;
  /** Số dòng forecast_accuracy_sku của tháng. */
  accRows: number;
  /** min(computed_at) của forecast_accuracy_sku trong tháng. */
  accComputedAt: Date | null;
  /** Cờ closed đang lưu (null nếu chưa có dòng, hoặc lẫn cả hai giá trị). */
  accClosed: boolean | null;
}

/**
 * Tháng có phải tính lại không. Một trong các điều sau là đủ:
 *   - số dòng hai phía khác nhau (thêm/xoá dòng nguồn)
 *   - nguồn được ghi SAU lần tính cuối
 *   - cờ closed đã đổi (mùng 1: tháng trước vừa khép ⇒ phải có %)
 */
export function needsRefresh(s: MonthState, now: Date): boolean {
  if (s.sourceRows !== s.accRows) return true;
  if (s.sourceRows === 0) return false;
  if (s.accClosed !== isClosedMonth(s.period, now)) return true;
  if (!s.accComputedAt || !s.sourceUpdatedAt) return true;
  return s.sourceUpdatedAt > s.accComputedAt;
}
