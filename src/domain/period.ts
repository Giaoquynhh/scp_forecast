import type { Weights } from './forecast-formula.js';

/**
 * Cách định nghĩa 3 khối B1/B2/B3 dùng để tính FC.
 *
 * 'calendar' — 3 tháng dương lịch liền trước tháng đích (T = tháng 9 → 8, 7, 6).
 *              Đây là cách đã chốt: app chạy vào mùng 1 nên cả 3 tháng đã đóng sổ.
 * 'rolling'  — 3 cửa sổ 30 ngày đếm ngược từ ngày đầu tháng đích.
 */
export type BlockMode = 'calendar' | 'rolling';

/** Một khối dữ liệu bán dùng để tính FC: [from, to) kèm trọng số. */
export interface Block {
  label: string;
  /** ngày bắt đầu, bao gồm — 'YYYY-MM-DD' */
  from: string;
  /** ngày kết thúc, KHÔNG bao gồm — 'YYYY-MM-DD' */
  to: string;
  weight: number;
  days: number;
}

export function toDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Ngày đầu tháng, tính theo UTC để không bị lệch múi giờ. */
export function firstOfMonth(year: number, monthIndex0: number): Date {
  return new Date(Date.UTC(year, monthIndex0, 1));
}

/** Số ngày của tháng chứa `d`. */
export function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function addMonths(d: Date, n: number): Date {
  return firstOfMonth(d.getUTCFullYear(), d.getUTCMonth() + n);
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d.getTime());
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

/**
 * Tháng đích T.
 *  - `--month 2026-09` → 2026-09-01
 *  - không truyền     → ngày đầu THÁNG HIỆN TẠI (app chạy vào mùng 1)
 */
export function resolveTarget(monthArg?: string): Date {
  if (!monthArg) {
    const now = new Date();
    return firstOfMonth(now.getFullYear(), now.getMonth());
  }
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(monthArg.trim());
  if (!m) throw new Error(`--month phải có dạng YYYY-MM (nhận được: ${monthArg})`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Tháng không hợp lệ: ${monthArg}`);
  return firstOfMonth(year, month - 1);
}

/**
 * Ba khối B1/B2/B3, B1 là khối gần tháng đích nhất.
 *
 * calendar — 3 tháng dương lịch liền trước (T = 2026-09 → 08, 07, 06).
 * rolling  — 3 cửa sổ 30 ngày đếm ngược từ ngày đầu tháng đích.
 */
export function buildBlocks(
  target: Date,
  mode: BlockMode,
  weights: Weights,
): Block[] {
  if (mode === 'calendar') {
    return weights.map((weight, i) => {
      const from = addMonths(target, -(i + 1));
      const to = addMonths(target, -i);
      return {
        label: `B${i + 1} · ${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`,
        from: toDateOnly(from),
        to: toDateOnly(to),
        weight,
        days: daysInMonth(from),
      };
    });
  }

  return weights.map((weight, i) => {
    const from = addDays(target, -30 * (i + 1));
    const to = addDays(target, -30 * i);
    return {
      label: `B${i + 1} · ${toDateOnly(from)}→${toDateOnly(to)}`,
      from: toDateOnly(from),
      to: toDateOnly(to),
      weight,
      days: 30,
    };
  });
}
