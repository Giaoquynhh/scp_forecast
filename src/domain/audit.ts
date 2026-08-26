import { round2, type Weights } from './forecast-formula.js';
import { BadQueryError, assertMonth, parseCsvList } from './summary.js';
import type { BlockMode } from './period.js';
import type { ForecastLine } from './types.js';

/**
 * Đối chiếu: tính lại FC + MA3 rồi đặt cạnh giá trị đang có trong DB.
 *
 * Trả lời hai câu không thể trả lời bằng cách đọc DB một mình:
 *   - Số trong DB có đúng bằng số tính lại từ sales không? (`fcDiff` / `ma3Diff`)
 *   - Cặp nào có bán mà DB chưa có dòng? (`inDb: false`)
 *
 * Nghiệp vụ thuần: không SQL, không import pg. Phần so sánh là hàm thuần nên
 * test được bằng số liệu tay.
 */

/** Giá trị đang lưu trong DB của một cặp, kèm dấu vết ai ghi. */
export interface StoredForecast {
  fcQty: number | null;
  ma3: number | null;
  actualQty: number | null;
  version: number;
  source: string;
  lastUpdatedBy: string;
  lastUpdatedAt: string;
}

/** Một dòng đối chiếu: tính lại vs DB. */
export interface AuditRow {
  cnCode: string;
  skuCode: string;
  b1: number;
  b2: number;
  b3: number;
  weighted: number;
  perDay: number;
  /** FC tính lại từ sales. */
  fcQty: number;
  /** MA3 tính lại từ sales. */
  ma3: number;

  /** false = có bán trong 3 khối nhưng DB chưa có dòng cho tháng này. */
  inDb: boolean;
  dbFcQty: number | null;
  dbMa3: number | null;
  dbActualQty: number | null;
  dbVersion: number | null;
  dbSource: string | null;
  dbLastUpdatedBy: string | null;
  dbLastUpdatedAt: string | null;

  /** fcQty − dbFcQty. null khi DB chưa có dòng hoặc chưa có FC. */
  fcDiff: number | null;
  ma3Diff: number | null;
  /** true = lệch quá ngưỡng, tức DB đang KHÔNG khớp với số tính lại. */
  differs: boolean;
}

export interface AuditTotals {
  /** Số cặp có bán trong 3 khối — đây là số dòng FC lẽ ra phải có. */
  pairs: number;
  fcQty: number;
  ma3Qty: number;
  /** Tổng FC hiện có trong DB, chỉ trên các cặp có bán. */
  dbFcQty: number;
  dbMa3Qty: number;
  fcDiff: number;
  ma3Diff: number;
  /** Số dòng lệch quá ngưỡng. 0 = DB khớp hoàn toàn với số tính lại. */
  rowsDiffer: number;
  /** Số cặp có bán mà DB chưa có dòng — chưa bao giờ được ghi. */
  rowsMissingInDb: number;
  /** Số dòng DB có MA3 là NULL trong khi tính lại ra số. */
  rowsMa3Null: number;
}

/** Lệch nhỏ hơn mức này coi như bằng nhau — cột nguồn là numeric(15,2). */
export const DIFF_EPSILON = 0.01;

export interface AuditQuery {
  /** 'YYYY-MM' — tháng đích của FC. */
  month: string;
  cnCodes?: string[];
  skuCodes?: string[];
  /** Chỉ trả về dòng lệch. Dùng khi chỉ cần biết "có sai chỗ nào không". */
  diffOnly: boolean;
  limit: number;
  offset: number;
  /** Ghi đè trọng số cho lần tính này. Không đổi cấu hình chung, không ghi DB. */
  weights?: Weights;
  blockMode?: BlockMode;
  perDayDivisor?: number;
}

/** Hợp đồng đọc trạng thái hiện tại của branch_forecast. */
export interface AuditReader {
  /** Giá trị đang lưu của tháng đó, theo khóa `cnCode|skuCode`. */
  storedForecast(
    periodStart: string,
    cnCodes?: string[],
    skuCodes?: string[],
  ): Promise<Map<string, StoredForecast>>;

  /** Ai đã ghi tháng đó, mỗi (người ghi × source) bao nhiêu dòng. */
  writers(periodStart: string): Promise<WriterStat[]>;

  /** Các lượt ghi của app, mới nhất trước. */
  recentRuns(periodStart: string, actor: string, limit: number): Promise<RunStat[]>;
}

export interface WriterStat {
  lastUpdatedBy: string;
  source: string;
  rows: number;
  withFc: number;
  withMa3: number;
  withActual: number;
  lastAt: string;
  maxVersion: number;
}

export interface RunStat {
  /** Gom theo phút — một lượt ghi vài nghìn dòng trong cùng một phút. */
  at: string;
  changedBy: string;
  rows: number;
  changedFc: number;
  changedMa3: number;
  changedActual: number;
  inserted: number;
  reason: string | null;
}

// ── so sánh ────────────────────────────────────────────────────────────────

/** Khóa nghiệp vụ của một cặp trong một tháng. */
export function pairKey(cnCode: string, skuCode: string): string {
  return `${cnCode}|${skuCode}`;
}

/** Một dòng tính lại + giá trị DB tương ứng → dòng đối chiếu. Hàm thuần. */
export function toAuditRow(line: ForecastLine, stored: StoredForecast | undefined): AuditRow {
  const fcDiff = stored?.fcQty === undefined || stored.fcQty === null
    ? null
    : round2(line.fcQty - stored.fcQty);
  const ma3Diff = stored?.ma3 === undefined || stored.ma3 === null
    ? null
    : round2(line.ma3 - stored.ma3);

  // Thiếu dòng, hoặc thiếu giá trị, cũng là lệch — không phải "không so được".
  // Nếu coi null là bằng nhau thì 3.073 dòng chưa có MA3 sẽ báo là khớp.
  const differs = stored === undefined
    || stored.fcQty === null || stored.ma3 === null
    || Math.abs(fcDiff ?? 0) > DIFF_EPSILON
    || Math.abs(ma3Diff ?? 0) > DIFF_EPSILON;

  return {
    cnCode: line.cnCode,
    skuCode: line.skuCode,
    b1: line.blocks.b1,
    b2: line.blocks.b2,
    b3: line.blocks.b3,
    weighted: line.weighted,
    perDay: round2(line.perDay),
    fcQty: line.fcQty,
    ma3: line.ma3,
    inDb: stored !== undefined,
    dbFcQty: stored?.fcQty ?? null,
    dbMa3: stored?.ma3 ?? null,
    dbActualQty: stored?.actualQty ?? null,
    dbVersion: stored?.version ?? null,
    dbSource: stored?.source ?? null,
    dbLastUpdatedBy: stored?.lastUpdatedBy ?? null,
    dbLastUpdatedAt: stored?.lastUpdatedAt ?? null,
    fcDiff,
    ma3Diff,
    differs,
  };
}

/** Tổng của TOÀN BỘ dòng đối chiếu — gọi trước khi phân trang. */
export function auditTotals(rows: AuditRow[]): AuditTotals {
  const t: AuditTotals = {
    pairs: rows.length,
    fcQty: 0, ma3Qty: 0, dbFcQty: 0, dbMa3Qty: 0,
    fcDiff: 0, ma3Diff: 0,
    rowsDiffer: 0, rowsMissingInDb: 0, rowsMa3Null: 0,
  };

  for (const r of rows) {
    t.fcQty += r.fcQty;
    t.ma3Qty += r.ma3;
    t.dbFcQty += r.dbFcQty ?? 0;
    t.dbMa3Qty += r.dbMa3 ?? 0;
    if (r.differs) t.rowsDiffer += 1;
    if (!r.inDb) t.rowsMissingInDb += 1;
    if (r.inDb && r.dbMa3 === null) t.rowsMa3Null += 1;
  }

  t.fcQty = round2(t.fcQty);
  t.ma3Qty = round2(t.ma3Qty);
  t.dbFcQty = round2(t.dbFcQty);
  t.dbMa3Qty = round2(t.dbMa3Qty);
  t.fcDiff = round2(t.fcQty - t.dbFcQty);
  t.ma3Diff = round2(t.ma3Qty - t.dbMa3Qty);
  return t;
}

// ── kiểm tra tham số ───────────────────────────────────────────────────────

const MAX_LIMIT = 20_000;

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const raw = (params.get('month') ?? '').trim();
  if (!raw) throw new BadQueryError('month là bắt buộc (YYYY-MM)');

  return {
    month: assertMonth(raw, 'month'),
    cnCodes: parseCsvList(params.get('cnCode') ?? undefined),
    skuCodes: parseCsvList(params.get('skuCode') ?? undefined),
    diffOnly: params.get('diffOnly') === 'true' || params.get('diffOnly') === '1',
    limit: parseInt_(params.get('limit'), 100, 1, MAX_LIMIT, 'limit'),
    offset: parseInt_(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    weights: parseWeights(params.get('weights')),
    blockMode: parseBlockMode(params.get('blockMode')),
    perDayDivisor: params.get('divisor') === null
      ? undefined
      : parseNumber(params.get('divisor'), 'divisor', 0),
  };
}

/** '0.5,0.3,0.2' → [0.5,0.3,0.2]. Không bắt tổng phải bằng 1 — công thức không đòi. */
export function parseWeights(raw: string | null): Weights | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 3) {
    throw new BadQueryError(`weights cần đúng 3 số ngăn bằng phẩy (nhận được: ${raw})`);
  }
  const nums = parts.map((p, i) => parseNumber(p, `weights[${i}]`, -Infinity));
  return [nums[0], nums[1], nums[2]] as Weights;
}

export function parseBlockMode(raw: string | null): BlockMode | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'calendar' || v === 'rolling') return v;
  throw new BadQueryError(`blockMode phải là calendar hoặc rolling (nhận được: ${raw})`);
}

function parseNumber(raw: string | null, field: string, exclusiveMin: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadQueryError(`${field} không phải số: ${raw}`);
  if (n <= exclusiveMin) throw new BadQueryError(`${field} phải > ${exclusiveMin} (nhận được: ${raw})`);
  return n;
}

function parseInt_(
  raw: string | null, def: number, min: number, max: number, field: string,
): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadQueryError(`${field} phải là số nguyên trong ${min}..${max} (nhận được: ${raw})`);
  }
  return n;
}
