import cron from 'node-cron';
import { CFG } from '../config.js';
import { firstOfMonth } from '../domain/period.js';
import { buildRunner } from './container.js';
import { stamp } from './runner.js';

/**
 * Daemon cron.
 *
 * Mỗi 02:00 (giờ VN):
 *   - TT: luôn tính lại cho tháng hiện tại. Mỗi lượt là tính LẠI tổng lũy kế từ
 *     sales_transaction_v2, nên dữ liệu bán mới đổ về hôm trước tự động được
 *     cộng vào (02:00 ngày 17 → tổng ngày 01→16). Tháng đã qua coi như chốt sổ,
 *     không cập nhật lại nữa.
 *   - FC + MA3: chỉ chạy vào MÙNG 1, vì công thức cần 3 tháng liền trước đã
 *     đóng sổ. Mùng 1 cũng là lúc chốt sổ TT tháng trước lần cuối.
 */
export function startDaemon(dryRun = false): void {
  if (!cron.validate(CFG.cronSchedule)) {
    throw new Error(`CRON_SCHEDULE không hợp lệ: ${CFG.cronSchedule}`);
  }

  const runner = buildRunner();

  console.log('─'.repeat(64));
  console.log(`scp-forecast daemon · ${stamp()}`);
  console.log(`Lịch        ${CFG.cronSchedule}  (${CFG.timezone})`);
  console.log(`TT          mỗi lượt, ${CFG.ttMonths} tháng gần nhất`);
  console.log(
    `FC + MA3    ${CFG.fcRecomputeDaily ? 'mỗi lượt' : `chỉ ngày ${CFG.fcDayOfMonth} hằng tháng`}`,
  );
  if (dryRun) console.log('CHẾ ĐỘ      dry-run — mỗi lượt chỉ tính, không ghi DB');
  console.log('Ctrl+C để dừng.');
  console.log('─'.repeat(64));

  let running = false;

  const task = cron.schedule(
    CFG.cronSchedule,
    async () => {
      // Lượt trước chưa xong thì bỏ lượt này, tránh 2 tiến trình cùng ghi.
      if (running) {
        console.warn(`[${stamp()}] Lượt trước còn đang chạy — bỏ qua lượt này.`);
        return;
      }
      running = true;

      const now = new Date();
      const target = firstOfMonth(now.getFullYear(), now.getMonth());
      const isFcDay = now.getDate() === CFG.fcDayOfMonth;
      const doFc = CFG.fcRecomputeDaily || isFcDay;

      // Ngày thường: chỉ tháng hiện tại. Mùng 1: thêm tháng trước để chốt sổ
      // lần cuối rồi khóa luôn.
      const ttMonths = isFcDay && CFG.ttCloseoutPrevMonth
        ? Math.max(CFG.ttMonths, 2)
        : CFG.ttMonths;

      console.log(
        `\n[${stamp()}] Bắt đầu lượt — ${doFc ? 'TT + FC' : 'chỉ TT'}` +
        (ttMonths > CFG.ttMonths ? ' (chốt sổ tháng trước)' : ''),
      );
      try {
        const s = await runner.run({
          target,
          only: doFc ? 'both' : 'tt',
          dryRun,
          ttMonths,
        });
        console.log(
          `[${stamp()}] Xong — thêm ${s.written.inserted} · sửa ${s.written.updated}` +
          ` · giữ nguyên ${s.written.skipped}`,
        );
      } catch (err) {
        // Nuốt lỗi để daemon sống tiếp; lượt sau thử lại.
        console.error(`[${stamp()}] LỖI trong lượt chạy:`, err instanceof Error ? err.message : err);
      } finally {
        running = false;
      }
    },
    { timezone: CFG.timezone },
  );

  const stop = (sig: string) => {
    console.log(`\n[${stamp()}] Nhận ${sig}, dừng daemon.`);
    task.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
