import {
  forecastQty, hasDemand, movingAverage3, perDay, round2, weightedDemand,
  type Weights,
} from '../domain/forecast-formula.js';
import { buildBlocks, daysInMonth, toDateOnly, type BlockMode } from '../domain/period.js';
import type {
  ActualLine, ForecastLine, ForecastRecord, ForecastWriter, SalesReader, WriteResult,
} from '../domain/types.js';

/** Ghi đè tham số công thức cho một lần tính. Trường bỏ trống thì lấy từ CFG. */
export interface FormulaOverride {
  weights?: Weights;
  blockMode?: BlockMode;
  perDayDivisor?: number;
}

export interface ForecastServiceDeps {
  sales: SalesReader;
  writer: ForecastWriter;
  weights: Weights;
  blockMode: BlockMode;
  perDayDivisor: number;
  sourceFc: string;
  sourceTt: string;
  actor: string;
}

export interface CalcResult {
  forecast: ForecastLine[];
  actuals: ActualLine[];
  /** cặp từng có TT nhưng kỳ này không còn bán → đưa về 0 */
  clearedActuals: ActualLine[];
  latestSalesDate: string | null;
}

/**
 * Điều phối: lấy số từ SalesReader, áp công thức thuần của domain, đẩy kết quả
 * qua ForecastWriter. Bản thân service không có câu SQL nào và không biết mình
 * đang nói chuyện với Postgres — nên test được bằng reader/writer giả.
 */
export class ForecastService {
  constructor(private readonly deps: ForecastServiceDeps) {}

  /**
   * Ghi đè tham số công thức cho MỘT lần gọi, không đụng cấu hình chung.
   *
   * Chỉ dùng cho đường đọc (API đối chiếu "nếu đổi trọng số thì FC ra bao nhiêu").
   * Đường ghi luôn dùng CFG để số trong DB không phụ thuộc vào ai gọi API với
   * tham số gì.
   */
  private resolve(over?: FormulaOverride) {
    return {
      weights: over?.weights ?? this.deps.weights,
      blockMode: over?.blockMode ?? this.deps.blockMode,
      perDayDivisor: over?.perDayDivisor ?? this.deps.perDayDivisor,
    };
  }

  /** Mô tả 3 khối của tháng đích, dùng để in ra log. */
  blocksFor(target: Date, over?: FormulaOverride) {
    const f = this.resolve(over);
    return buildBlocks(target, f.blockMode, f.weights);
  }

  /** Ngày có dữ liệu bán mới nhất kể từ mốc — để biết cron đang nhìn tới đâu. */
  latestSalesDate(since: string): Promise<string | null> {
    return this.deps.sales.latestSalesDate(since);
  }

  /** Tính FC + MA3 cho tháng đích. Không ghi gì. */
  async calculateForecast(target: Date, over?: FormulaOverride): Promise<ForecastLine[]> {
    const f = this.resolve(over);
    const periodStart = toDateOnly(target);
    const days = daysInMonth(target);
    const blocks = this.blocksFor(target, over);
    const totals = await this.deps.sales.blockTotals(
      blocks.map((b) => ({ from: b.from, to: b.to })),
    );

    const lines: ForecastLine[] = [];
    for (const t of totals) {
      if (!hasDemand(t)) continue; // cặp không bán gì thì không tạo dòng mới
      const weighted = weightedDemand(t, f.weights);
      lines.push({
        cnCode: t.cnCode,
        skuCode: t.skuCode,
        periodStart,
        blocks: { b1: round2(t.b1), b2: round2(t.b2), b3: round2(t.b3) },
        weighted: round2(weighted),
        perDay: perDay(weighted, f.perDayDivisor),
        fcQty: forecastQty(t, f.weights, f.perDayDivisor, days),
        ma3: movingAverage3(t),
      });
    }
    return lines;
  }

  /**
   * Tính TT cho khoảng tháng, kèm danh sách cặp cần đưa về 0 (từng có TT nhưng
   * kỳ này không còn phát sinh bán — nếu bỏ qua thì số cũ nằm lại vĩnh viễn).
   */
  async calculateActuals(
    fromMonth: string,
    toMonth: string,
  ): Promise<{ actuals: ActualLine[]; cleared: ActualLine[] }> {
    const actuals = await this.deps.sales.monthlyActuals(fromMonth, toMonth);
    const present = new Set(actuals.map(keyOf));
    const existing = await this.deps.writer.pairsWithActuals(fromMonth, toMonth);
    const cleared = existing
      .filter((r) => !present.has(keyOf(r)))
      .map((r) => ({ ...r, actualQty: 0 }));
    return { actuals, cleared };
  }

  /**
   * Dòng của tháng đích đang có FC/MA3 khác 0 nhưng kỳ này không còn phát sinh
   * bán → đưa về 0. Không có bước này thì số của lần chạy trước (hoặc của FC
   * engine cũ bên SCP) nằm lại vĩnh viễn trên những cặp đã ngừng bán.
   */
  async staleForecast(periodStart: string, computed: ForecastLine[]): Promise<ForecastRecord[]> {
    const present = new Set(computed.map((l) => `${l.cnCode}|${l.skuCode}|${l.periodStart}`));
    const existing = await this.deps.writer.pairsWithForecast(periodStart);
    return existing
      .filter((r) => !present.has(`${r.cnCode}|${r.skuCode}|${r.periodStart}`))
      .map((r) => ({ ...r, fcQty: 0, ma3: 0 }));
  }

  async writeForecast(
    lines: ForecastLine[],
    periodStart: string,
    cleared: ForecastRecord[] = [],
  ): Promise<WriteResult> {
    const records: ForecastRecord[] = [
      ...lines.map((l) => ({
        cnCode: l.cnCode,
        skuCode: l.skuCode,
        periodStart: l.periodStart,
        fcQty: l.fcQty,
        ma3: l.ma3,
      })),
      ...cleared,
    ];
    return this.deps.writer.write(records, {
      source: this.deps.sourceFc,
      changedBy: this.deps.actor,
      reason: `FC+MA3 ${this.deps.blockMode} w=${this.deps.weights.join('/')} cho ${periodStart}`,
    });
  }

  /**
   * Điền bù MA3 vào các dòng ĐÃ CÓ, không đụng fc_qty và không thêm dòng mới.
   *
   * Dùng cho tháng cũ: FC ở đó do engine trước ghi và là bằng chứng engine ấy đã
   * dự báo gì — ghi đè lên là mất luôn cơ sở để đo accuracy sau này. MA3 thì
   * chưa từng có nên điền vào không xoá mất gì.
   *
   * `cleared` là các dòng đang có MA3 nhưng kỳ này không còn phát sinh bán → về 0.
   */
  async writeMa3(
    lines: ForecastLine[],
    periodStart: string,
    cleared: ForecastRecord[] = [],
  ): Promise<WriteResult> {
    const records: ForecastRecord[] = [
      ...lines.map((l) => ({
        cnCode: l.cnCode,
        skuCode: l.skuCode,
        periodStart: l.periodStart,
        ma3: l.ma3,
      })),
      ...cleared.map((r) => ({
        cnCode: r.cnCode, skuCode: r.skuCode, periodStart: r.periodStart, ma3: 0,
      })),
    ];
    return this.deps.writer.write(records, {
      source: this.deps.sourceFc,
      changedBy: this.deps.actor,
      reason: `MA3 điền bù ${this.deps.blockMode} cho ${periodStart}`,
      updateOnly: true,
      keepSource: true,
    });
  }

  async writeActuals(lines: ActualLine[]): Promise<WriteResult> {
    const records: ForecastRecord[] = lines.map((l) => ({
      cnCode: l.cnCode,
      skuCode: l.skuCode,
      periodStart: l.periodStart,
      actualQty: l.actualQty,
    }));
    return this.deps.writer.write(records, {
      source: this.deps.sourceTt,
      changedBy: this.deps.actor,
      reason: 'TT tính lại từ sales_transaction_v2',
    });
  }
}

function keyOf(r: ActualLine): string {
  return `${r.cnCode}|${r.skuCode}|${r.periodStart}`;
}
