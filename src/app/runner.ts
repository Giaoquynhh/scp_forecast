import { CFG } from '../config.js';
import { addMonths, daysInMonth, toDateOnly } from '../domain/period.js';
import { describeConnection } from '../infra/db.js';
import type { ActualLine, ForecastLine, ForecastRecord } from '../domain/types.js';
import type { ForecastService } from './forecast.service.js';

export interface RunOptions {
  /** ngày đầu tháng đích */
  target: Date;
  only: 'fc' | 'tt' | 'both';
  dryRun: boolean;
  ttMonths: number;
  limit?: number;
}

export interface RunSummary {
  fcPairs: number;
  fcCleared: number;
  fcTotal: number;
  ma3Total: number;
  ttRows: number;
  ttTotal: number;
  written: { inserted: number; updated: number; skipped: number };
}

const fmt = new Intl.NumberFormat('vi-VN');
const line = '─'.repeat(64);

export function stamp(): string {
  return new Date().toLocaleString('vi-VN', { timeZone: CFG.timezone });
}

/**
 * Một lượt tính + ghi, kèm phần in ra màn hình. Đây là tầng mỏng nhất: nó chỉ
 * gọi service và trình bày kết quả — không chứa công thức, không chứa SQL.
 */
export class Runner {
  constructor(private readonly service: ForecastService) {}

  async run(opts: RunOptions): Promise<RunSummary> {
    const periodStart = toDateOnly(opts.target);
    const summary: RunSummary = {
      fcPairs: 0, fcCleared: 0, fcTotal: 0, ma3Total: 0, ttRows: 0, ttTotal: 0,
      written: { inserted: 0, updated: 0, skipped: 0 },
    };

    await this.printHeader(opts, periodStart);

    let forecast: ForecastLine[] = [];
    let clearedForecast: ForecastRecord[] = [];
    let actuals: ActualLine[] = [];

    if (opts.only !== 'tt') {
      forecast = await this.service.calculateForecast(opts.target);
      clearedForecast = await this.service.staleForecast(periodStart, forecast);
      summary.fcPairs = forecast.length;
      summary.fcCleared = clearedForecast.length;
      summary.fcTotal = sum(forecast, (l) => l.fcQty);
      summary.ma3Total = sum(forecast, (l) => l.ma3);
      console.log(
        `FC   ${fmt.format(summary.fcPairs)} cặp CN×SKU · tổng ${m2(summary.fcTotal)}` +
        (clearedForecast.length ? ` · ${fmt.format(clearedForecast.length)} dòng đưa về 0` : ''),
      );
      console.log(`MA3  trung bình trượt 3 tháng · tổng ${m2(summary.ma3Total)}`);
    }

    if (opts.only !== 'fc') {
      const from = toDateOnly(addMonths(opts.target, -(opts.ttMonths - 1)));
      const res = await this.service.calculateActuals(from, periodStart);
      actuals = [...res.actuals, ...res.cleared];
      summary.ttRows = res.actuals.length;
      summary.ttTotal = sum(res.actuals, (l) => l.actualQty);
      console.log(
        `TT   ${fmt.format(summary.ttRows)} dòng [${from} → ${periodStart}] · tổng ${m2(summary.ttTotal)}` +
        (res.cleared.length ? ` · ${res.cleared.length} dòng đưa về 0` : ''),
      );
      const latest = await this.service.latestSalesDate(periodStart);
      console.log(`     dữ liệu bán của tháng đích có tới ngày ${latest ?? '—'}`);
    }

    if (opts.limit !== undefined) {
      forecast = forecast.slice(0, opts.limit);
      clearedForecast = clearedForecast.slice(0, opts.limit);
      actuals = actuals.slice(0, opts.limit);
      console.log(`--limit ${opts.limit}: chỉ ghi ${forecast.length} dòng FC, ${actuals.length} dòng TT`);
    }

    if (opts.dryRun) {
      console.log(`Dry-run: bỏ qua ${fmt.format(forecast.length)} dòng FC và ${fmt.format(actuals.length)} dòng TT.`);
      return summary;
    }

    // TT ghi trước để tháng đích có TT trước khi FC đè lên cùng dòng.
    if (actuals.length > 0) {
      const r = await this.service.writeActuals(actuals);
      this.accumulate(summary, r);
      console.log(`Ghi TT   ${describe(r)}`);
    }
    if (forecast.length > 0 || clearedForecast.length > 0) {
      const r = await this.service.writeForecast(forecast, periodStart, clearedForecast);
      this.accumulate(summary, r);
      console.log(`Ghi FC   ${describe(r)}`);
    }

    return summary;
  }

  private async printHeader(opts: RunOptions, periodStart: string): Promise<void> {
    console.log(line);
    console.log(
      `DB          ${CFG.db.user}@${CFG.db.host}:${CFG.db.port}/${CFG.db.database}` +
      `  ·  ${await describeConnection()}`,
    );
    console.log(`Tháng đích  ${periodStart}  (${daysInMonth(opts.target)} ngày)`);
    if (opts.only !== 'tt') {
      console.log(`Kiểu khối   ${CFG.blockMode}`);
      for (const b of this.service.blocksFor(opts.target)) {
        console.log(`  ${b.label.padEnd(26)} [${b.from} → ${b.to})  ${b.days} ngày  ×${b.weight}`);
      }
      console.log(
        `Công thức   FC = (Σ wᵢ·Bᵢ) / ${CFG.perDayDivisor} × ${daysInMonth(opts.target)}` +
        `   ·   MA3 = (B1+B2+B3) / 3`,
      );
    }
    if (opts.dryRun) console.log('CHẾ ĐỘ      dry-run — không ghi gì vào DB');
    console.log(line);
  }

  private accumulate(s: RunSummary, r: { inserted: number; updated: number; skipped: number }): void {
    s.written.inserted += r.inserted;
    s.written.updated += r.updated;
    s.written.skipped += r.skipped;
  }
}

function sum<T>(rows: T[], pick: (r: T) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

function m2(n: number): string {
  return `${fmt.format(Math.round(n))} m²`;
}

function describe(r: { inserted: number; updated: number; skipped: number }): string {
  return `thêm ${fmt.format(r.inserted)} · sửa ${fmt.format(r.updated)} · giữ nguyên ${fmt.format(r.skipped)}`;
}
