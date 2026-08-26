import { round2 } from './forecast-formula.js';

/**
 * Tổng lượng gạch FC / MA3 / TT — nghiệp vụ thuần, không có SQL, không import pg.
 *
 * Ba con số đọc thẳng từ branch_forecast, KHÔNG tính lại: fc_qty và ma3 do app này
 * ghi lúc sinh FC, actual_qty do app này ghi lúc tính TT. Endpoint chỉ cộng.
 *
 * NULL ≠ 0. `actual_qty IS NULL` là "tháng chưa có TT", `ma3 IS NULL` là "dòng do
 * FC engine cũ bên SCP ghi, chưa có MA3". Cộng chúng như 0 sẽ làm mẫu số của
 * WMAPE sai và sai số nhìn nhỏ đi một cách giả tạo.
 */

export type GroupBy = 'cn' | 'month' | 'cn-month' | 'none';

/** Bộ lọc đã kiểm tra hợp lệ — repository nhận đúng kiểu này, không nhận chuỗi thô. */
export interface SummaryQuery {
  /** 'YYYY-MM', bao gồm. */
  from: string;
  /** 'YYYY-MM', bao gồm. */
  to: string;
  groupBy: GroupBy;
  cnCodes?: string[];
  skuCodes?: string[];
  /** Ẩn SKU Ngừng (sku.active = false). Mặc định true — khớp grid/cn bên SCP. */
  hideInactiveSku: boolean;
  /** true = đọc cột GENERATED fc_qty_rounded / actual_qty_rounded (làm tròn hàng trăm). */
  rounded: boolean;
}

/** Số thô repository gom được cho một nhóm. Chưa chia, chưa làm tròn. */
export interface SummaryAggregate {
  cnCode: string | null;
  cnName: string | null;
  region: string | null;
  /** 'YYYY-MM' — null khi nhóm không chia theo tháng. */
  month: string | null;

  fcQty: number | null;
  ma3Qty: number | null;
  actualQty: number | null;

  /** Σ|fc − actual| trên các dòng có ĐỦ cả hai. */
  fcAbsErr: number | null;
  /** Σactual trên đúng tập dòng đó — mẫu số của fcWmapePct. */
  actualComparable: number | null;
  /** Σ|ma3 − actual| trên các dòng có đủ ma3 và actual. */
  ma3AbsErr: number | null;
  /** Σactual trên đúng tập dòng đó — mẫu số của ma3WmapePct. */
  actualComparableMa3: number | null;

  rowCount: number;
  skuCount: number;
  cnCount: number;
  ma3RowCount: number;
  comparableRowCount: number;
}

/** Một dòng trả ra ngoài HTTP. */
export interface SummaryRow {
  cnCode: string | null;
  cnName: string | null;
  region: string | null;
  month: string | null;

  fcQty: number | null;
  ma3Qty: number | null;
  actualQty: number | null;

  /** fcQty − actualQty. Dương = dự báo cao hơn thực bán. null khi thiếu một trong hai. */
  gapQty: number | null;
  /** gapQty / actualQty × 100. null khi actualQty null hoặc 0. */
  gapPct: number | null;

  /**
   * Σ|fc − actual| / Σactual × 100, chỉ trên dòng có đủ cả hai.
   * Khác |gapPct| ở chỗ sai số thừa của SKU này KHÔNG bù trừ sai số thiếu của SKU kia —
   * tổng có thể khớp hoàn hảo trong khi từng SKU sai bét.
   */
  fcWmapePct: number | null;
  /** Cùng công thức cho MA3, để trả lời "MA3 có bám sát hơn FC không". */
  ma3WmapePct: number | null;

  rowCount: number;
  skuCount: number;
  cnCount: number;
  /** Thấp hơn rowCount nghĩa là MA3 chưa phủ hết — còn dòng của engine cũ. */
  ma3RowCount: number;
  /** Số dòng có đủ fc lẫn actual — mẫu số của fcWmapePct. */
  comparableRowCount: number;
}

export interface SummaryResult {
  from: string;
  to: string;
  groupBy: GroupBy;
  rounded: boolean;
  rows: SummaryRow[];
  /**
   * Tổng của TOÀN BỘ khoảng lọc — không phải tổng của `rows`. skuCount/cnCount là
   * đếm phân biệt nên không cộng dồn từ các nhóm con được (một SKU bán ở 5 CN vẫn
   * là 1 SKU), vì vậy dòng này được gom riêng bằng một lượt GROUP BY rỗng.
   */
  total: SummaryRow;
}

/** Hợp đồng đọc số tổng. Service phụ thuộc interface này, không phụ thuộc Postgres. */
export interface SummaryReader {
  aggregate(query: SummaryQuery, groupBy: GroupBy): Promise<SummaryAggregate[]>;
}

// ── phép chia dùng chung ───────────────────────────────────────────────────

/** x / y × 100, làm tròn 2 chữ số. null khi thiếu số hoặc mẫu số 0. */
export function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return round2((numerator / denominator) * 100);
}

/** Số thô → dòng trả ra ngoài. Hàm thuần, test được bằng số liệu tay. */
export function toSummaryRow(a: SummaryAggregate): SummaryRow {
  const fcQty = nullableRound2(a.fcQty);
  const actualQty = nullableRound2(a.actualQty);
  const gapQty = fcQty === null || actualQty === null ? null : round2(fcQty - actualQty);

  return {
    cnCode: a.cnCode,
    cnName: a.cnName,
    region: a.region,
    month: a.month,
    fcQty,
    ma3Qty: nullableRound2(a.ma3Qty),
    actualQty,
    gapQty,
    gapPct: pct(gapQty, actualQty),
    fcWmapePct: pct(a.fcAbsErr, a.actualComparable),
    ma3WmapePct: pct(a.ma3AbsErr, a.actualComparableMa3),
    rowCount: a.rowCount,
    skuCount: a.skuCount,
    cnCount: a.cnCount,
    ma3RowCount: a.ma3RowCount,
    comparableRowCount: a.comparableRowCount,
  };
}

/** Không dòng nào khớp bộ lọc — khung rỗng để phía gọi khỏi phải kiểm tra undefined. */
export function emptySummaryRow(): SummaryRow {
  return {
    cnCode: null, cnName: null, region: null, month: null,
    fcQty: null, ma3Qty: null, actualQty: null,
    gapQty: null, gapPct: null, fcWmapePct: null, ma3WmapePct: null,
    rowCount: 0, skuCount: 0, cnCount: 0, ma3RowCount: 0, comparableRowCount: 0,
  };
}

function nullableRound2(n: number | null): number | null {
  return n === null || !Number.isFinite(n) ? null : round2(n);
}

// ── kiểm tra tham số ───────────────────────────────────────────────────────

/** Lỗi do người gọi truyền sai — tầng HTTP dịch thành 400, không phải 500. */
export class BadQueryError extends Error {}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertMonth(value: string, field: string): string {
  if (!MONTH_RE.test(value)) {
    throw new BadQueryError(`${field} phải có dạng YYYY-MM (nhận được: ${value})`);
  }
  return value;
}

/** Giá trị lạ thì báo lỗi chứ không đoán — đoán sai ra số sai mà không ai biết. */
export function parseGroupBy(raw: string | undefined): GroupBy {
  if (raw === undefined || raw === '') return 'cn';
  if (raw === 'cn' || raw === 'month' || raw === 'cn-month' || raw === 'none') return raw;
  throw new BadQueryError(`groupBy phải là cn | month | cn-month | none (nhận được: ${raw})`);
}

/** 'a, b ,c' → ['a','b','c']; rỗng/thiếu → undefined (nghĩa là không lọc). */
export function parseCsvList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** Mặc định BẬT — chỉ tắt khi nhận chuỗi phủ định rõ ràng. Khớp hành vi của SCP. */
export function parseBool(raw: string | undefined, def: boolean): boolean {
  if (raw === undefined || raw === '') return def;
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return def;
}

/** Tháng hiện tại theo giờ máy chủ, 'YYYY-MM'. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Chuỗi query của HTTP → bộ lọc đã kiểm tra. Hàm thuần: nhận Map<string,string>
 * chứ không nhận Request, nên test không cần dựng server.
 */
export function parseSummaryQuery(
  params: URLSearchParams,
  now: Date = new Date(),
): SummaryQuery {
  const from = assertMonth((params.get('from') ?? '').trim() || currentMonth(now), 'from');
  const to = assertMonth((params.get('to') ?? '').trim() || from, 'to');
  if (to < from) throw new BadQueryError(`to (${to}) không được nhỏ hơn from (${from})`);

  return {
    from,
    to,
    groupBy: parseGroupBy(params.get('groupBy') ?? undefined),
    cnCodes: parseCsvList(params.get('cnCode') ?? undefined),
    skuCodes: parseCsvList(params.get('skuCode') ?? undefined),
    hideInactiveSku: parseBool(params.get('hideInactiveSku') ?? undefined, true),
    rounded: parseBool(params.get('rounded') ?? undefined, false),
  };
}
