import { isClosedMonth, needsRefresh, refreshWindow } from '../domain/accuracy.js';
import type { AccuracyRepository } from '../infra/accuracy.repository.js';

export interface AccuracyRunOptions {
  /** Các tháng được xét (YYYY-MM-DD ngày 1). Mặc định: refreshWindow(now). */
  periods?: string[];
  /** true = dựng lại mọi tháng trong `periods`, kể cả tháng không cũ. */
  force?: boolean;
  dryRun?: boolean;
  now?: Date;
}

export interface AccuracyRunSummary {
  checked: number;
  refreshed: Array<{ period: string; closed: boolean; skuRows: number; cnRows: number }>;
}

/**
 * Dựng bảng forecast_accuracy_* sau mỗi lượt tính TT / FC.
 *
 * Chỉ dựng lại tháng CŨ (xem needsRefresh) — ngày thường thường chỉ là tháng hiện
 * tại; mùng 1 thêm tháng trước (cờ closed đổi ⇒ lúc này mới có %).
 */
export class AccuracyService {
  constructor(private readonly repo: AccuracyRepository) {}

  async run(opts: AccuracyRunOptions = {}): Promise<AccuracyRunSummary> {
    const now = opts.now ?? new Date();
    const periods = opts.periods ?? refreshWindow(now);
    const states = await this.repo.monthStates(periods);
    const todo = states.filter((s) => opts.force ? s.sourceRows > 0 || s.accRows > 0 : needsRefresh(s, now));

    const refreshed: AccuracyRunSummary['refreshed'] = [];
    for (const s of todo) {
      const closed = isClosedMonth(s.period, now);
      if (opts.dryRun) {
        refreshed.push({ period: s.period, closed, skuRows: s.sourceRows, cnRows: 0 });
        continue;
      }
      const r = await this.repo.refreshMonth(s.period, closed);
      refreshed.push({ period: s.period, closed, ...r });
    }
    return { checked: states.length, refreshed };
  }
}

/** In kết quả một lượt — chung cho CLI và daemon. */
export function printAccuracySummary(s: AccuracyRunSummary, dryRun = false): void {
  if (s.refreshed.length === 0) {
    console.log(`Accuracy  ${s.checked} tháng đã xét · không tháng nào cần tính lại`);
    return;
  }
  const fmt = new Intl.NumberFormat('vi-VN');
  console.log(`Accuracy  ${s.checked} tháng đã xét · ${dryRun ? 'SẼ ' : ''}tính lại ${s.refreshed.length} tháng`);
  for (const r of s.refreshed) {
    console.log(
      `  ${r.period.slice(0, 7)}  ${r.closed ? 'đã khép, có %' : 'chưa khép, chưa chấm'}` +
      `  ·  ${fmt.format(r.skuRows)} dòng mã${dryRun ? '' : ` · ${fmt.format(r.cnRows)} dòng CN`}`,
    );
  }
}
