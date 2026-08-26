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

/**
 * Ngày trong tháng mà FC được sinh.
 *
 * 'day'     — ngày cố định: 1 = mùng 1.
 * 'fromEnd' — đếm ngược từ cuối tháng: 0 = ngày cuối, 1 = trước ngày cuối 1 ngày.
 *             Phải đếm ngược vì tháng dài 28..31 ngày, không có "ngày 31" cố định.
 */
export type FcDaySpec =
  | { kind: 'day'; day: number }
  | { kind: 'fromEnd'; offset: number };

/** Chế độ chọn tháng đích khi daemon tự chạy. */
export type FcTargetMode = 'current' | 'next';

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
 *  - không truyền      → theo `mode`: 'next' là tháng sau, 'current' là tháng này.
 *
 * `mode` lấy từ FC_TARGET để lượt chạy tay ra cùng tháng đích với lượt cron —
 * nếu không, cuối tháng 8 cron ghi FC tháng 9 mà `npm start` lại ghi tháng 8.
 */
export function resolveTarget(monthArg?: string, mode: FcTargetMode = 'current'): Date {
  if (!monthArg) return fcTargetMonth(new Date(), mode);
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(monthArg.trim());
  if (!m) throw new Error(`--month phải có dạng YYYY-MM (nhận được: ${monthArg})`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Tháng không hợp lệ: ${monthArg}`);
  return firstOfMonth(year, month - 1);
}

// ── lịch sinh FC ───────────────────────────────────────────────────────────

/** Số ngày của tháng, nhận trực tiếp năm + chỉ số tháng (0..11) — không qua Date UTC. */
export function daysInMonthOf(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * `FC_DAY_OF_MONTH` → FcDaySpec.
 *   'last'    → ngày cuối tháng
 *   'last-2'  → trước ngày cuối 2 ngày (29/08, 26/02…)
 *   '1'       → mùng 1
 */
export function parseFcDaySpec(raw: string): FcDaySpec {
  const v = raw.trim().toLowerCase();
  if (v === 'last') return { kind: 'fromEnd', offset: 0 };

  const fromEnd = /^last-(\d+)$/.exec(v);
  if (fromEnd) {
    const offset = Number(fromEnd[1]);
    if (offset > 27) {
      throw new Error(`FC_DAY_OF_MONTH=${raw}: offset phải <= 27 (tháng 2 chỉ có 28 ngày)`);
    }
    return { kind: 'fromEnd', offset };
  }

  const day = Number(v);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`FC_DAY_OF_MONTH phải là 1..31, 'last' hoặc 'last-N' (nhận được: ${raw})`);
  }
  return { kind: 'day', day };
}

/**
 * Hôm nay có phải ngày sinh FC?
 *
 * Với kind='day', ngày lớn hơn số ngày của tháng được kẹp về ngày cuối — nếu
 * không, đặt 31 là tháng 2 và tháng 4 sẽ không bao giờ sinh FC.
 */
export function isFcRunDay(now: Date, spec: FcDaySpec): boolean {
  const days = daysInMonthOf(now.getFullYear(), now.getMonth());
  const wanted = spec.kind === 'day'
    ? Math.min(spec.day, days)
    : days - spec.offset;
  return now.getDate() === wanted;
}

export function describeFcDaySpec(spec: FcDaySpec): string {
  if (spec.kind === 'day') return `ngày ${spec.day} hằng tháng`;
  return spec.offset === 0 ? 'ngày cuối tháng' : `trước ngày cuối tháng ${spec.offset} ngày`;
}

/** Tháng đích của lượt daemon: tháng hiện tại, hoặc tháng sau. */
export function fcTargetMonth(now: Date, mode: FcTargetMode): Date {
  const base = firstOfMonth(now.getFullYear(), now.getMonth());
  return mode === 'next' ? addMonths(base, 1) : base;
}

/**
 * Số ngày của khối [from, to) chưa có dữ liệu bán.
 *
 * Sinh FC vào cuối tháng thì B1 là tháng ĐANG chạy, chưa đóng sổ — thiếu vài
 * ngày cuối. B1 mang trọng số nặng nhất (0.6) nên phần thiếu này kéo FC xuống,
 * và không có gì trong công thức báo cho biết. Hàm này để lượt chạy nói ra.
 *
 * `latest` là ngày bán mới nhất thực có trong bảng, không phải hôm nay — dữ liệu
 * bán thường về trễ một hai ngày so với ngày thực.
 */
export function missingDaysInBlock(
  block: { from: string; to: string },
  latest: string | null,
): number {
  const total = daysBetween(block.from, block.to);
  if (latest === null || latest < block.from) return total;
  // `to` không bao gồm, nên ngày cuối có dữ liệu lý tưởng là to − 1 ngày.
  if (latest >= block.to) return 0;
  return daysBetween(latest, block.to) - 1;
}

/** Số ngày giữa hai mốc 'YYYY-MM-DD', đầu bao gồm, cuối không. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
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
