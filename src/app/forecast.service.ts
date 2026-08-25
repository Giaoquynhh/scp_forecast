import {
  forecastQty, hasDemand, movingAverage3, perDay, round2, weightedDemand,
  type Weights,
} from '../domain/forecast-formula.js';
import { buildBlocks, daysInMonth, toDateOnly, type BlockMode } from '../domain/period.js';
import type {
  ActualLine, ForecastLine, ForecastRecord, ForecastWriter, SalesReader, WriteResult,
} from '../domain/types.js';

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

  /** Mô tả 3 khối của tháng đích, dùng để in ra log. */
  blocksFor(target: Date) {
    return buildBlocks(target, this.deps.blockMode, this.deps.weights);
  }

  /** Ngày có dữ liệu bán mới nhất kể từ mốc — để biết cron đang nhìn tới đâu. */
  latestSalesDate(since: string): Promise<string | null> {
    return this.deps.sales.latestSalesDate(since);
  }

  /** Tính FC + MA3 cho tháng đích. Không ghi gì. */
  async calculateForecast(target: Date): Promise<ForecastLine[]> {
    const periodStart = toDateOnly(target);
    const days = daysInMonth(target);
    const blocks = this.blocksFor(target);
    const totals = await this.deps.sales.blockTotals(
      blocks.map((b) => ({ from: b.from, to: b.to })),
    );

    const lines: ForecastLine[] = [];
    for (const t of totals) {
      if (!hasDemand(t)) continue; // cặp không bán gì thì không tạo dòng mới
      const weighted = weightedDemand(t, this.deps.weights);
      lines.push({
        cnCode: t.cnCode,
        skuCode: t.skuCode,
        periodStart,
        blocks: { b1: round2(t.b1), b2: round2(t.b2), b3: round2(t.b3) },
        weighted: round2(weighted),
        perDay: perDay(weighted, this.deps.perDayDivisor),
        fcQty: forecastQty(t, this.deps.weights, this.deps.perDayDivisor, days),
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
