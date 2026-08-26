/**
 * Kiểu dữ liệu của tầng nghiệp vụ. Tầng này KHÔNG biết gì về Postgres —
 * không import pg, không có chuỗi SQL nào.
 */

/** Lượng bán m² của một cặp CN×SKU trong 3 khối, B1 gần tháng đích nhất. */
export interface BlockTotals {
  b1: number;
  b2: number;
  b3: number;
}

/** Lượng bán 3 khối gắn với một cặp CN×SKU cụ thể. */
export interface PairBlockTotals extends BlockTotals {
  cnCode: string;
  skuCode: string;
}

/** Kết quả tính cho một cặp CN×SKU của tháng đích. */
export interface ForecastLine {
  cnCode: string;
  skuCode: string;
  periodStart: string;
  blocks: BlockTotals;
  weighted: number;
  perDay: number;
  fcQty: number;
  ma3: number;
}

/** Lượng bán thực tế của một cặp CN×SKU trong một tháng. */
export interface ActualLine {
  cnCode: string;
  skuCode: string;
  periodStart: string;
  actualQty: number;
}

/** Một dòng chuẩn bị ghi xuống branch_forecast. Bỏ trống = giữ nguyên giá trị cũ. */
export interface ForecastRecord {
  cnCode: string;
  skuCode: string;
  periodStart: string;
  fcQty?: number | null;
  actualQty?: number | null;
  ma3?: number | null;
}

export interface WriteOptions {
  source: string;
  changedBy: string;
  reason?: string;
  /**
   * true = chỉ sửa dòng đã có, KHÔNG thêm dòng mới.
   *
   * Dùng khi điền bù một cột vào dữ liệu cũ (`--only ma3`): cặp có bán mà DB
   * chưa có dòng thì để yên, vì thêm dòng mới ở tháng đã chốt sổ là mở rộng
   * phạm vi dữ liệu chứ không còn là điền bù.
   */
  updateOnly?: boolean;
  /**
   * true = giữ nguyên `source` cũ của dòng.
   *
   * Điền bù MA3 vào một dòng mà FC do engine khác ghi thì không được đổi nhãn
   * `source` của dòng đó — nhãn phải nói ai ghi FC, không phải ai chạm vào sau.
   */
  keepSource?: boolean;
}

export interface WriteResult {
  inserted: number;
  updated: number;
  /** dòng đã đúng giá trị → không đụng tới, không ghi lịch sử */
  skipped: number;
  /** `updateOnly` mà DB chưa có dòng → bỏ qua, không thêm mới */
  notFound: number;
}

/**
 * Hợp đồng đọc dữ liệu bán. Service phụ thuộc vào interface này chứ không phụ
 * thuộc Postgres — nhờ vậy test service chỉ cần một object giả, không cần DB.
 */
export interface SalesReader {
  /** Tổng bán m² của từng cặp CN×SKU trong 3 khối [from, to). */
  blockTotals(ranges: Array<{ from: string; to: string }>): Promise<PairBlockTotals[]>;

  /** Tổng bán m² theo cặp CN×SKU × tháng, trong khoảng tháng [from, to]. */
  monthlyActuals(fromMonth: string, toMonth: string): Promise<ActualLine[]>;

  /** Ngày có dữ liệu bán mới nhất kể từ `since`. */
  latestSalesDate(since: string): Promise<string | null>;
}

/** Hợp đồng ghi xuống branch_forecast. */
export interface ForecastWriter {
  write(records: ForecastRecord[], opts: WriteOptions): Promise<WriteResult>;

  /** Các cặp đang có actual_qty khác 0 trong khoảng tháng — để phát hiện dòng cần đưa về 0. */
  pairsWithActuals(fromMonth: string, toMonth: string): Promise<ActualLine[]>;

  /**
   * Các cặp của tháng đích đang có fc_qty hoặc ma3 khác 0 — để đưa về 0 những
   * dòng kỳ này không còn phát sinh bán (số cũ của lần chạy trước nằm lại).
   */
  pairsWithForecast(periodStart: string): Promise<Array<{
    cnCode: string; skuCode: string; periodStart: string;
  }>>;
}
