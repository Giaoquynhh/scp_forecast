import { CFG } from '../config.js';
import {
  addMonths, daysInMonth, missingDaysInBlock, toDateOnly, type Block,
} from '../domain/period.js';
import { describeConnection } from '../infra/db.js';
import type {
  ActualLine, ForecastLine, ForecastRecord, WriteResult,
} from '../domain/types.js';
import type { ForecastService } from './forecast.service.js';

/**
 * 'both' — TT + FC + MA3 (lượt bình thường)
 * 'fc'   — chỉ FC + MA3
 * 'tt'   — chỉ TT
 * 'ma3'  — CHỈ điền MA3 vào dòng đã có; không đụng fc_qty, không thêm dòng mới.
 *          Dành cho tháng cũ, nơi FC của engine trước phải giữ nguyên.
 */
export type RunMode = 'fc' | 'tt' | 'both' | 'ma3';

export interface RunOptions {
  /** Ngày đầu tháng đích của FC + MA3. */
  target: Date;
  /**
   * Tháng mới nhất được tính lại TT. Mặc định = `target`.
   *
   * Phải tách khỏi `target` từ khi FC chạy cuối tháng: cuối tháng 8 thì FC nhắm
   * tháng 9, nhưng TT phải vẫn là tháng 8 — tính TT cho tháng 9 lúc đó sẽ không
   * ra dòng nào (chưa có ngày bán nào) và đưa mọi dòng TT sẵn có về 0.
   */
  ttTarget?: Date;
  only: RunMode;
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
      if (opts.only !== 'ma3') {
        console.log(
          `FC   ${fmt.format(summary.fcPairs)} cặp CN×SKU · tổng ${m2(summary.fcTotal)}` +
          (clearedForecast.length ? ` · ${fmt.format(clearedForecast.length)} dòng đưa về 0` : ''),
        );
      }
      console.log(
        `MA3  ${fmt.format(summary.fcPairs)} cặp CN×SKU · tổng ${m2(summary.ma3Total)}` +
        (opts.only === 'ma3' ? '  (chỉ MA3 — fc_qty giữ nguyên)' : ''),
      );
    }

    if (opts.only !== 'fc' && opts.only !== 'ma3') {
      const ttTo = toDateOnly(opts.ttTarget ?? opts.target);
      const from = toDateOnly(addMonths(opts.ttTarget ?? opts.target, -(opts.ttMonths - 1)));
      const res = await this.service.calculateActuals(from, ttTo);
      actuals = [...res.actuals, ...res.cleared];
      summary.ttRows = res.actuals.length;
      summary.ttTotal = sum(res.actuals, (l) => l.actualQty);
      console.log(
        `TT   ${fmt.format(summary.ttRows)} dòng [${from} → ${ttTo}] · tổng ${m2(summary.ttTotal)}` +
        (res.cleared.length ? ` · ${res.cleared.length} dòng đưa về 0` : ''),
      );
      const latest = await this.service.latestSalesDate(ttTo);
      console.log(`     dữ liệu bán của tháng ${ttTo.slice(0, 7)} có tới ngày ${latest ?? '—'}`);
    }

    if (opts.limit !== undefined) {
      forecast = forecast.slice(0, opts.limit);
      clearedForecast = clearedForecast.slice(0, opts.limit);
      actuals = actuals.slice(0, opts.limit);
      console.log(`--limit ${opts.limit}: chỉ ghi ${forecast.length} dòng FC, ${actuals.length} dòng TT`);
    }

    if (opts.dryRun) {
      const what = opts.only === 'ma3' ? 'dòng MA3' : 'dòng FC';
      console.log(`Dry-run: bỏ qua ${fmt.format(forecast.length)} ${what} và ${fmt.format(actuals.length)} dòng TT.`);
      return summary;
    }

    // TT ghi trước để tháng đích có TT trước khi FC đè lên cùng dòng.
    if (actuals.length > 0) {
      const r = await this.service.writeActuals(actuals);
      this.accumulate(summary, r);
      console.log(`Ghi TT   ${describe(r)}`);
    }
    if (forecast.length > 0 || clearedForecast.length > 0) {
      const r = opts.only === 'ma3'
        ? await this.service.writeMa3(forecast, periodStart, clearedForecast)
        : await this.service.writeForecast(forecast, periodStart, clearedForecast);
      this.accumulate(summary, r);
      console.log(`Ghi ${opts.only === 'ma3' ? 'MA3 ' : 'FC  '} ${describe(r)}`);
    }

    return summary;
  }

  private async printHeader(opts: RunOptions, periodStart: string): Promise<void> {
    console.log(line);
    console.log(
      `DB          ${CFG.db.user}@${CFG.db.host}:${CFG.db.port}/${CFG.db.database}` +
      `  ·  ${await describeConnection()}`,
    );
    // Chỉ nói "tháng đích" khi lượt này thật sự tính FC — lượt chỉ-TT in tháng
    // đích của FC ra sẽ làm người đọc log tưởng TT đang tính cho tháng đó.
    if (opts.only === 'tt') {
      console.log(`Tháng TT    ${toDateOnly(opts.ttTarget ?? opts.target).slice(0, 7)}`);
    } else {
      console.log(`Tháng đích  ${periodStart}  (${daysInMonth(opts.target)} ngày)`);
    }
    if (opts.only !== 'tt') {
      console.log(`Kiểu khối   ${CFG.blockMode}`);
      const blocks = this.service.blocksFor(opts.target);
      for (const b of blocks) {
        console.log(`  ${b.label.padEnd(26)} [${b.from} → ${b.to})  ${b.days} ngày  ×${b.weight}`);
      }
      console.log(
        `Công thức   FC = (Σ wᵢ·Bᵢ) / ${CFG.perDayDivisor} × ${daysInMonth(opts.target)}` +
        `   ·   MA3 = (B1+B2+B3) / 3`,
      );
      await this.warnIfBlocksOpen(blocks);
    }
    if (opts.dryRun) console.log('CHẾ ĐỘ      dry-run — không ghi gì vào DB');
    console.log(line);
  }

  /**
   * Khối chưa đóng sổ thì FC hụt, mà công thức không có gì báo ra. Chạy cuối
   * tháng là trường hợp thường gặp nhất: B1 là tháng đang chạy, còn thiếu 1-2
   * ngày cuối, và B1 mang trọng số nặng nhất.
   *
   * Chỉ cảnh báo, KHÔNG tự bù — bù là đổi công thức, phải hỏi nghiệp vụ trước.
   */
  private async warnIfBlocksOpen(blocks: Block[]): Promise<void> {
    const latest = await this.service.latestSalesDate(blocks[blocks.length - 1].from);
    let shortfall = 0;

    for (const b of blocks) {
      const missing = missingDaysInBlock(b, latest);
      if (missing <= 0) continue;
      const share = (b.weight * missing) / b.days;
      shortfall += share;
      console.warn(
        `  ⚠ ${b.label} chưa đóng sổ: thiếu ${missing}/${b.days} ngày` +
        ` (dữ liệu bán mới nhất ${latest ?? '—'}), trọng số ×${b.weight}`,
      );
    }

    if (shortfall > 0) {
      // Ước lượng theo trọng số là mức SÀN: nó giả định mỗi ngày bán như nhau,
      // nhưng ngày cuối tháng bán nhiều hơn trung bình. Đo trên dữ liệu thật
      // (tháng 7/2026, thiếu 1 ngày): tính ra 1,9% mà thực tế lệch 3,5%.
      console.warn(
        `  ⚠ FC hụt ít nhất ${(shortfall * 100).toFixed(1)}% — thực tế thường gấp đôi vì` +
        ' ngày cuối tháng bán nhiều hơn trung bình.' +
        (CFG.fcFinalizeOnFirst
          ? ' Lượt mùng 1 sẽ tính lại khi các khối đã đủ ngày.'
          : ' FC_FINALIZE_ON_FIRST đang tắt — số này sẽ nằm lại nguyên như vậy.'),
      );
    }
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

function describe(r: WriteResult): string {
  return `thêm ${fmt.format(r.inserted)} · sửa ${fmt.format(r.updated)}` +
    ` · giữ nguyên ${fmt.format(r.skipped)}` +
    (r.notFound > 0 ? ` · ${fmt.format(r.notFound)} cặp chưa có dòng, bỏ qua` : '');
}
