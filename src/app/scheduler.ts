import cron from 'node-cron';
import { CFG } from '../config.js';
import {
  describeFcDaySpec, fcTargetMonth, firstOfMonth, isFcRunDay, toDateOnly,
} from '../domain/period.js';
import { buildAccuracyService, buildRunner } from './container.js';
import { printAccuracySummary } from './accuracy.service.js';
import { stamp } from './runner.js';

/**
 * Daemon cron.
 *
 * Mỗi 02:00 (giờ VN):
 *   - TT: luôn tính lại cho tháng hiện tại. Mỗi lượt là tính LẠI tổng lũy kế từ
 *     sales_transaction_v2, nên dữ liệu bán mới đổ về hôm trước tự động được
 *     cộng vào (02:00 ngày 17 → tổng ngày 01→16). Tháng đã qua coi như chốt sổ,
 *     không cập nhật lại nữa.
 *   - TB trượt bán n ngày (cột `sales_ma_qty` — F1-B3 bên SCP đọc): luôn tính lại,
 *     mọi lượt. Cửa sổ tính tới hôm nay nên nó cũ đi mỗi ngày, không đợi ngày sinh
 *     FC. Chạy trong cả lượt 'both' lẫn lượt 'tt' — xem SALES_MA_MODES ở runner.
 *   - FC + MA3: chạy CUỐI THÁNG cho tháng SAU, vì cuối tháng mới là lúc người
 *     dùng xem để dự báo. Cộng thêm một lượt mùng 1 để chốt lại — xem dưới.
 *
 * ─── Vì sao FC chạy hai lượt mỗi tháng ──────────────────────────────────────
 * Lượt cuối tháng lấy tháng ĐANG chạy làm B1, mà tháng đó chưa đóng sổ: 02:00
 * ngày 31/08 thì dữ liệu bán mới tới khoảng 30/08. B1 mang trọng số 0.6 nên FC
 * hụt vài phần trăm. Lượt mùng 1 tính lại đúng tháng đó khi B1 đã đủ ngày.
 *
 *   31/08 02:00 → FC tháng 9 (B1 = tháng 8 còn hở)   ← số xem trước
 *   01/09 02:00 → FC tháng 9 (B1 = tháng 8 đã đủ)    ← số chốt
 *
 * FC là idempotent nên lượt hai chỉ sửa những dòng thật sự đổi. Tắt lượt chốt
 * bằng FC_FINALIZE_ON_FIRST=false; về hẳn cách cũ (chỉ mùng 1) bằng
 * FC_DAY_OF_MONTH=1 + FC_TARGET=current.
 */
export interface RunPlan {
  /** Tháng đích của FC + MA3. */
  fcTarget: Date;
  /** Tháng mới nhất tính lại TT — luôn là tháng hiện tại. */
  ttTarget: Date;
  doFc: boolean;
  /** true = lượt mùng 1 tính lại FC của tháng vừa bắt đầu, khi B1 đã đủ ngày. */
  finalize: boolean;
  ttMonths: number;
}

/**
 * Lượt chạy hôm nay làm gì. Hàm thuần — test được bằng cách đưa vào một ngày
 * bất kỳ, không cần dựng daemon hay chờ tới cuối tháng.
 */
export function planRun(now: Date, cfg = CFG): RunPlan {
  const thisMonth = firstOfMonth(now.getFullYear(), now.getMonth());
  const isFcDay = isFcRunDay(now, cfg.fcDay);
  const isFirst = now.getDate() === 1;
  const finalize = cfg.fcFinalizeOnFirst && isFirst && !isFcDay;

  // Lượt chốt nhắm tháng VỪA BẮT ĐẦU, không phải tháng sau: cuối tháng 8 đã ghi
  // FC tháng 9, mùng 1/9 là tính lại chính tháng 9 đó khi B1 (tháng 8) đã đóng sổ.
  const fcTarget = finalize ? thisMonth : fcTargetMonth(now, cfg.fcTarget);

  // Mùng 1: thêm tháng trước vào phạm vi TT để chốt sổ lần cuối rồi khóa luôn.
  // Gắn với mùng 1 chứ không gắn với ngày sinh FC — TT có nhịp riêng.
  const ttMonths = isFirst && cfg.ttCloseoutPrevMonth
    ? Math.max(cfg.ttMonths, 2)
    : cfg.ttMonths;

  return {
    fcTarget,
    ttTarget: thisMonth,
    doFc: cfg.fcRecomputeDaily || isFcDay || finalize,
    finalize,
    ttMonths,
  };
}

/**
 * FC_DAY_OF_MONTH và FC_TARGET phải đi thành cặp. Ghép sai thì app vẫn chạy,
 * vẫn ghi DB, chỉ có số là vô nghĩa — nên phải nói ra lúc khởi động chứ không
 * đợi ai đó phát hiện qua báo cáo.
 *
 * Ghép sai điển hình: FC_DAY_OF_MONTH=1 (bản cũ) mà FC_TARGET=next (mặc định
 * mới). Mùng 1/9 sẽ sinh FC cho tháng 10 với B1 = tháng 9 — gần như trống rỗng.
 */
function warnIfScheduleMismatched(): void {
  if (CFG.fcRecomputeDaily) return;
  const { fcDay, fcTarget } = CFG;

  if (fcTarget === 'next' && fcDay.kind === 'day' && fcDay.day <= 20) {
    console.warn(
      `            ⚠ FC_DAY_OF_MONTH=${fcDay.day} + FC_TARGET=next: sinh FC cho tháng sau khi` +
      ' tháng này mới bắt đầu, B1 gần như trống. Dùng FC_DAY_OF_MONTH=last,' +
      ' hoặc FC_TARGET=current.',
    );
  }
  if (fcTarget === 'current' && fcDay.kind === 'fromEnd') {
    console.warn(
      '            ⚠ FC_DAY_OF_MONTH=last + FC_TARGET=current: cuối tháng mới sinh FC cho' +
      ' chính tháng đó — dự báo cho một tháng đã gần hết. Có lẽ muốn FC_TARGET=next.',
    );
  }
}

export function startDaemon(dryRun = false): void {
  if (!cron.validate(CFG.cronSchedule)) {
    throw new Error(`CRON_SCHEDULE không hợp lệ: ${CFG.cronSchedule}`);
  }

  const runner = buildRunner();
  const accuracy = buildAccuracyService();

  console.log('─'.repeat(64));
  console.log(`scp-forecast daemon · ${stamp()}`);
  console.log(`Lịch        ${CFG.cronSchedule}  (${CFG.timezone})`);
  console.log(`TT          mỗi lượt, ${CFG.ttMonths} tháng gần nhất`);
  console.log('TB trượt    mỗi lượt, cửa sổ n ngày theo system_config planning.ma_months');
  console.log('Accuracy    mỗi lượt, sau TT/FC — dựng lại forecast_accuracy_* của tháng cũ');
  console.log(
    `FC + MA3    ${CFG.fcRecomputeDaily
      ? 'mỗi lượt'
      : `${describeFcDaySpec(CFG.fcDay)} → tháng ${CFG.fcTarget === 'next' ? 'sau' : 'hiện tại'}`}`,
  );
  if (CFG.fcFinalizeOnFirst && !CFG.fcRecomputeDaily) {
    console.log('            + mùng 1 chốt lại tháng vừa bắt đầu (B1 đã đủ ngày)');
  }
  warnIfScheduleMismatched();
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
      const plan = planRun(now);

      console.log(
        `\n[${stamp()}] Bắt đầu lượt — ${plan.doFc ? 'TT + FC' : 'chỉ TT'}` +
        (plan.doFc ? ` cho tháng ${toDateOnly(plan.fcTarget).slice(0, 7)}` : '') +
        (plan.finalize ? ' (lượt chốt)' : '') +
        (plan.ttMonths > CFG.ttMonths ? ' · chốt sổ TT tháng trước' : ''),
      );
      try {
        const s = await runner.run({
          target: plan.fcTarget,
          ttTarget: plan.ttTarget,
          only: plan.doFc ? 'both' : 'tt',
          dryRun,
          ttMonths: plan.ttMonths,
        });
        console.log(
          `[${stamp()}] Xong — thêm ${s.written.inserted} · sửa ${s.written.updated}` +
          ` · giữ nguyên ${s.written.skipped}`,
        );
      } catch (err) {
        // Nuốt lỗi để daemon sống tiếp; lượt sau thử lại.
        console.error(`[${stamp()}] LỖI trong lượt chạy:`, err instanceof Error ? err.message : err);
      }
      // Accuracy chạy SAU và TÁCH khỏi lượt chính: lỗi ở đây không được làm mất TT/FC
      // vừa ghi. Mùng 1 đây là lúc tháng trước được chấm (closed đổi ⇒ tính lại).
      try {
        printAccuracySummary(await accuracy.run({ now, dryRun }), dryRun);
      } catch (err) {
        console.error(`[${stamp()}] LỖI khi dựng accuracy:`, err instanceof Error ? err.message : err);
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
