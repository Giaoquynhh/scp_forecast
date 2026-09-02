import { CFG } from '../config.js';
import {
  addMonths, daysInMonth, firstOfMonth, missingDaysInBlock, toDateOnly, type Block,
} from '../domain/period.js';
import { describeConnection } from '../infra/db.js';
import type {
  ActualLine, ForecastLine, ForecastRecord, SalesMaLine, WriteResult,
} from '../domain/types.js';
import type { ForecastService } from './forecast.service.js';

/**
 * 'both' — TT + FC + MA3 (lượt bình thường)
 * 'fc'   — chỉ FC + MA3
 * 'tt'   — chỉ TT
 * 'ma3'  — CHỈ điền MA3 vào dòng đã có; không đụng fc_qty, không thêm dòng mới.
 *          Dành cho tháng cũ, nơi FC của engine trước phải giữ nguyên.
 * 'tt-fill'  — CHỈ lấp ô actual_qty còn TRỐNG mà tháng đó CÓ bán, bằng số bán thật.
 *          Thuần bổ sung thông tin: không ghi đè số nào, không tạo ô tt = 0 nào.
 *
 *          Đây là lỗ đã mất 66.140 m² của 2026-04..08: ô trống có bán không thuộc
 *          'tt-close' (nhóm đó lọc "không bán") và cũng không được 'tt-close' ghi vì
 *          mode đó bỏ `res.actuals` — nên nằm NULL vĩnh viễn, trong khi log vẫn in ra
 *          số dòng sổ bán vừa tính nên nhìn như đã ghi.
 *
 * 'tt-close' — CHỈ đóng sổ actual_qty = 0 cho dòng có dự báo mà tháng đó không bán
 *          được gì. KHÔNG ghi lại TT của những dòng đã có số.
 *
 *          Tách khỏi 'tt-fill' vì hệ quả khác hẳn: lấp ô trống có bán là thêm sự thật
 *          đã biết, còn đóng sổ 0 kéo hàng nghìn ô (tt = 0, fc > 0) vào mẫu chấm và
 *          hạ accuracy toàn hệ thống — đúng nhưng là một quyết định vận hành, phải
 *          gọi tên riêng để không xảy ra như tác dụng phụ.
 *
 *          Cả hai mode đều dành cho tháng đã chốt sổ, nơi 'tt' (ghi đè từ
 *          sales_transaction_v2) là quá mạnh: sổ bán còn thêm giao dịch về sau (đo
 *          trên 2026-04: 89,4% cặp khớp, phần còn lại lệch tới +10% tổng).
 *
 * 'sales-ma' — CHỈ tính lại cột `sales_ma_qty` (TB trượt bán n ngày, m²/tháng) mà
 *          F1-B3 bên SCP đọc. Không đụng fc_qty / ma3 / actual_qty.
 */
export type RunMode = 'fc' | 'tt' | 'both' | 'ma3' | 'tt-fill' | 'tt-close' | 'sales-ma';

/** Mode chỉ chạm TT, không tính FC/MA3. */
const TT_ONLY: readonly RunMode[] = ['tt', 'tt-fill', 'tt-close', 'sales-ma'];

/**
 * Mode có tính lại TB trượt. Phải gồm cả 'tt' vì daemon chạy `only: 'tt'` vào ngày
 * thường — cột này cần tươi MỖI NGÀY, không đợi ngày sinh FC. Các mode vá dữ liệu cũ
 * ('ma3', 'tt-fill', 'tt-close') thì không: chúng nhắm tháng đã chốt, còn cửa sổ
 * trượt thì luôn tính tới hôm nay, hai thứ không liên quan gì nhau.
 */
const SALES_MA_MODES: readonly RunMode[] = ['both', 'tt', 'sales-ma'];

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
  /** Dòng có fc_qty nhưng thiếu ma3, được điền ma3 = 0 để giữ bất biến. */
  ma3Filled: number;
  ttRows: number;
  ttTotal: number;
  /** Dòng có dự báo mà tháng đó không bán được gì — đóng sổ actual_qty = 0. */
  ttUnsold: number;
  /** Ô actual_qty còn trống mà tháng đó CÓ bán — lấp bằng số thật. */
  ttUnfilled: number;
  /** Ô đã có số nay không khớp sổ bán. Chỉ báo, không lượt nào ở đây sửa. */
  ttDrift: { rows: number; net: number; abs: number };
  /** Ô có TT mà bỏ trống cột dự báo → điền FC = MA3 = 0 (công thức trên 3 khối rỗng). */
  fcZeroFilled: number;
  /** Ô TRỐNG HẲN (không có dòng) → tạo dòng FC = MA3 = TT = 0. */
  emptyCellsFilled: number;
  /** Cửa sổ TB trượt đang áp (ngày). 0 = lượt này không tính TB trượt. */
  salesMaDays: number;
  /** Số cặp CN×SKU có bán trong cửa sổ trượt. */
  salesMaPairs: number;
  /** Dòng đã rơi khỏi cửa sổ trượt → đưa về 0. */
  salesMaCleared: number;
  /** Σ TB trượt (m²/tháng) — cộng qua CN, bằng số F1-B3 thấy khi gộp toàn bộ SKU. */
  salesMaTotal: number;
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
      fcPairs: 0, fcCleared: 0, fcTotal: 0, ma3Total: 0, ma3Filled: 0,
      ttRows: 0, ttTotal: 0, ttUnsold: 0, ttUnfilled: 0,
      ttDrift: { rows: 0, net: 0, abs: 0 }, fcZeroFilled: 0, emptyCellsFilled: 0,
      salesMaDays: 0, salesMaPairs: 0, salesMaCleared: 0, salesMaTotal: 0,
      written: { inserted: 0, updated: 0, skipped: 0 },
    };

    await this.printHeader(opts, periodStart);

    let forecast: ForecastLine[] = [];
    let clearedForecast: ForecastRecord[] = [];
    let actuals: ActualLine[] = [];
    // Khoảng tháng TT, nâng ra ngoài vì bước điền FC = 0 sau khi ghi TT cũng cần đúng
    // khoảng này — chỉ những tháng engine ĐÃ tính FC mới được điền 0.
    let ttFrom: string | null = null;
    let ttTo: string | null = null;
    /** Khoá cặp×tháng CÓ trong sổ bán — chặn bước ghi ô trống ghi 0 lên chúng. */
    let soldKeys: Set<string> = new Set();

    if (!TT_ONLY.includes(opts.only)) {
      forecast = await this.service.calculateForecast(opts.target);
      // Hai nhóm dòng cùng cần chạm tới, ghi chung một lượt:
      //  - staleForecast : dòng CÓ số của lần chạy trước mà kỳ này không còn bán → về 0
      //  - fillMissingMa3: dòng có fc_qty nhưng thiếu ma3 → điền ma3 = 0
      // Phải khử trùng theo khoá: một dòng lọt cả hai nhóm sẽ thành hai tuple cùng khoá
      // trong một INSERT ... ON CONFLICT, và Postgres từ chối ("cannot affect row a
      // second time"). Ưu tiên bản của staleForecast vì nó đặt cả fc_qty lẫn ma3.
      const stale = await this.service.staleForecast(periodStart, forecast);
      const staleKeys = new Set(stale.map(keyOf));
      const missingMa3 = (await this.service.fillMissingMa3(periodStart, forecast))
        .filter((r) => !staleKeys.has(keyOf(r)));
      clearedForecast = [...stale, ...missingMa3];
      summary.fcPairs = forecast.length;
      summary.fcCleared = stale.length;
      summary.ma3Filled = missingMa3.length;
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
        (summary.ma3Filled ? ` · ${fmt.format(summary.ma3Filled)} dòng thiếu ma3 điền 0` : '') +
        (opts.only === 'ma3' ? '  (chỉ MA3 — fc_qty giữ nguyên)' : ''),
      );
    }

    if (opts.only !== 'fc' && opts.only !== 'ma3' && opts.only !== 'sales-ma') {
      ttTo = toDateOnly(opts.ttTarget ?? opts.target);
      ttFrom = toDateOnly(addMonths(opts.ttTarget ?? opts.target, -(opts.ttMonths - 1)));
      const from = ttFrom;
      const res = await this.service.calculateActuals(from, ttTo);

      // Mỗi mode ghi đúng MỘT nhóm, không mode nào tính ra rồi bỏ:
      //  'tt-fill'  → unfilled : ô trống CÓ bán, thuần bổ sung sự thật đã biết.
      //  'tt-close' → unsold   : ô trống KHÔNG bán → 0. Đúng sự thật nhưng kéo hàng
      //                          nghìn ô (tt = 0, fc > 0) vào mẫu chấm và hạ accuracy
      //                          toàn hệ thống, nên phải gọi tên riêng mới xảy ra.
      //  còn lại    → actuals + cleared : ghi đè từ sổ bán (dùng cho tháng đang chạy).
      //                          `unfilled` đã nằm trong `actuals` nên không cộng thêm.
      const writeSet: Record<string, ActualLine[]> = {
        'tt-fill': res.unfilled,
        'tt-close': res.unsold,
      };
      actuals = writeSet[opts.only] ?? [...res.actuals, ...res.cleared];
      summary.ttRows = res.actuals.length;
      summary.ttTotal = sum(res.actuals, (l) => l.actualQty);
      summary.ttUnsold = res.unsold.length;
      summary.ttUnfilled = res.unfilled.length;
      summary.ttDrift = res.drift;
      soldKeys = new Set(res.actuals.map(keyOf));

      // Log phải nói cái SẮP GHI, không phải cái vừa tính: các mode hẹp vẫn quét cả sổ
      // bán, và in con số lớn đó ra từng làm người vận hành tin là tháng cũ đã được
      // đối chiếu xong.
      if (opts.only === 'tt-fill' || opts.only === 'tt-close') {
        const ghi = actuals;
        console.log(
          `TT   ghi ${fmt.format(ghi.length)} ô ` +
          (opts.only === 'tt-fill'
            ? `trống có bán (${m2(sum(ghi, (l) => l.actualQty))})`
            : 'có dự báo mà bán 0 → 0') +
          `  [${from} → ${ttTo}]`,
        );
        console.log(
          `     đã quét ${fmt.format(summary.ttRows)} dòng sổ bán (${m2(summary.ttTotal)})` +
          ` — mode '${opts.only}' KHÔNG ghi đè ô đã có số` +
          (opts.only === 'tt-fill' && res.unsold.length
            ? `; ${fmt.format(res.unsold.length)} ô bán 0 để nguyên (xem '--only tt-close')`
            : ''),
        );
      } else {
        console.log(
          `TT   ${fmt.format(summary.ttRows)} dòng [${from} → ${ttTo}] · tổng ${m2(summary.ttTotal)}` +
          (res.cleared.length ? ` · ${res.cleared.length} dòng đưa về 0` : '') +
          (res.unfilled.length ? ` · ${fmt.format(res.unfilled.length)} ô trống được lấp` : ''),
        );
      }
      // Phần đã chốt nay lệch sổ bán: không lượt nào ở trên sửa nó, nên nếu không in
      // ra thì bảng Độ tin cậy đang chấm trên số cũ mà không ai biết.
      if (res.drift.rows > 0) {
        const dau = res.drift.net > 0 ? '+' : '';
        console.log(
          `     ⚠ ${fmt.format(res.drift.rows)} ô đã có số nay lệch sổ bán ` +
          `(net ${dau}${m2(res.drift.net)}, tuyệt đối ${m2(res.drift.abs)})` +
          ` — chạy '--only tt' nếu muốn ghi đè`,
        );
      }
      const latest = await this.service.latestSalesDate(ttTo);
      console.log(`     dữ liệu bán của tháng ${ttTo.slice(0, 7)} có tới ngày ${latest ?? '—'}`);
    }

    // TB trượt bán n ngày → cột `sales_ma_qty`, thứ F1-B3 bên SCP đọc thẳng.
    //
    // Cửa sổ luôn tính TỚI HÔM NAY, không theo tháng của dòng được ghi — nên nó chạy
    // mỗi ngày (kể cả lượt chỉ-TT), khác hẳn nhịp cuối-tháng của FC.
    let salesMa: SalesMaLine[] = [];
    let clearedSalesMa: ForecastRecord[] = [];
    if (SALES_MA_MODES.includes(opts.only)) {
      const maMonth = toDateOnly(opts.ttTarget ?? opts.target);
      const now = new Date();
      const thisMonth = toDateOnly(firstOfMonth(now.getFullYear(), now.getMonth()));

      // Cửa sổ trượt luôn tính TỚI HÔM NAY, nên chỉ có MỘT dòng đúng chỗ để ghi: dòng
      // tháng hiện tại. Lượt backfill tháng cũ (`--month 2026-01`) phải bỏ qua bước này
      // — ghi vào đó là dán số của hôm nay lên một tháng đã qua, và SCP (đọc dòng tháng
      // hiện tại) cũng không bao giờ thấy nó. Bỏ qua chứ không cảnh báo rồi vẫn ghi:
      // backfill cả năm là 9 lượt, 9 lần đè hỏng trước khi ai kịp đọc log.
      if (maMonth !== thisMonth) {
        console.log(
          `MA    bỏ qua TB trượt — lượt này nhắm tháng ${maMonth.slice(0, 7)},` +
          ` cửa sổ trượt chỉ ghi vào tháng hiện tại (${thisMonth.slice(0, 7)}).`,
        );
      } else {
        const { days, requested } = await this.service.salesMaDays();
        salesMa = await this.service.calculateSalesMa(maMonth, days);
        clearedSalesMa = await this.service.staleSalesMa(maMonth, salesMa);
        summary.salesMaDays = days;
        summary.salesMaPairs = salesMa.length;
        summary.salesMaCleared = clearedSalesMa.length;
        summary.salesMaTotal = sum(salesMa, (l) => l.salesMaQty);

        console.log(
          `MA${days}  ${fmt.format(summary.salesMaPairs)} cặp CN×SKU · tổng ${m2(summary.salesMaTotal)}/tháng` +
          ` · ghi vào dòng ${maMonth}` +
          (summary.salesMaCleared ? ` · ${fmt.format(summary.salesMaCleared)} dòng rơi khỏi cửa sổ → 0` : ''),
        );
        // Người dùng đặt n khác mà app đang khoá 90 thì phải nói ra — nhãn cột bên SCP
        // lấy từ config, nên im lặng là để nhãn ghi một đằng, số một nẻo.
        if (requested !== days) {
          console.warn(
            `     ⚠ planning.ma_months = ${requested} nhưng đang KHOÁ CỨNG ${days} ngày` +
            ` (SALES_MA_LOCK_DEFAULT). Số ghi ra là cửa sổ ${days} ngày.`,
          );
        }
      }
    }

    if (opts.limit !== undefined) {
      forecast = forecast.slice(0, opts.limit);
      clearedForecast = clearedForecast.slice(0, opts.limit);
      actuals = actuals.slice(0, opts.limit);
      salesMa = salesMa.slice(0, opts.limit);
      clearedSalesMa = clearedSalesMa.slice(0, opts.limit);
      console.log(
        `--limit ${opts.limit}: chỉ ghi ${forecast.length} dòng FC, ${actuals.length} dòng TT,` +
        ` ${salesMa.length} dòng TB trượt`,
      );
    }

    // Đường ghi TT tạo dòng mà không đặt cột dự báo nào. Để trống thì bên SCP loại ô
    // khỏi mẫu chấm, và cặp MỚI BẮT ĐẦU BÁN — loại trật nặng nhất — thành loại duy nhất
    // được miễn chấm. Với chúng cả 3 khối đầu vào rỗng nên công thức cho đúng 0, nên
    // điền 0 là nói ra kết quả thật, không phải bịa số.
    //
    // CỐ Ý không nằm trong nhánh `actuals.length > 0`: dòng cần điền có thể do LƯỢT
    // TRƯỚC tạo ra, khi đó lượt này không có TT nào phải ghi. Gắn vào nhánh đó thì hễ
    // hết ô TT trống là bước sửa cũng ngừng — đúng lúc dữ liệu đã đủ mà cột dự báo
    // vẫn trống.
    const zeroFc = ttFrom && ttTo
      ? await this.service.fillMissingForecast(ttFrom, ttTo)
      : [];
    summary.fcZeroFilled = zeroFc.length;
    if (zeroFc.length > 0) {
      console.log(
        `FC0  ${fmt.format(zeroFc.length)} ô có TT mà trống cột dự báo` +
        ` → điền FC = MA3 = 0 (3 khối đầu vào rỗng)`,
      );
    }

    // Ô TRỐNG HẲN: cặp có dòng ở tháng khác nhưng thiếu dòng ở tháng này. Engine đã chạy
    // tháng đó mà không sinh dòng ⇒ 3 khối rỗng ⇒ FC = MA3 = 0; TT cũng không có dòng
    // ⇒ tháng đó không bán ⇒ TT = 0. Tạo dòng thật để bên SCP không phải suy diễn, và để
    // cùng một sự thật không còn hai cách hiện ("100%" khi có dòng, "—" khi không).
    const empty = ttFrom && ttTo
      ? await this.service.fillEmptyCells(ttFrom, ttTo, soldKeys)
      : [];
    summary.emptyCellsFilled = empty.length;
    if (empty.length > 0) {
      console.log(
        `Ô0   ${fmt.format(empty.length)} ô trống hẳn (không dự báo, không bán)` +
        ` → tạo dòng FC = MA3 = TT = 0`,
      );
    }

    if (opts.dryRun) {
      const what = opts.only === 'ma3' ? 'dòng MA3' : 'dòng FC';
      console.log(
        `Dry-run: bỏ qua ${fmt.format(forecast.length)} ${what},` +
        ` ${fmt.format(actuals.length)} dòng TT, ${fmt.format(zeroFc.length)} dòng FC0,` +
        ` ${fmt.format(empty.length)} ô trống` +
        ` và ${fmt.format(salesMa.length + clearedSalesMa.length)} dòng TB trượt.`,
      );
      return summary;
    }

    // TT ghi trước để tháng đích có TT trước khi FC đè lên cùng dòng.
    if (actuals.length > 0) {
      const r = await this.service.writeActuals(actuals);
      this.accumulate(summary, r);
      console.log(`Ghi TT   ${describe(r)}`);
    }
    if (zeroFc.length > 0) {
      const rz = await this.service.writeZeroForecast(zeroFc);
      this.accumulate(summary, rz);
      console.log(`Ghi FC0  ${describe(rz)}`);
    }
    if (empty.length > 0) {
      const re = await this.service.writeEmptyCells(empty);
      this.accumulate(summary, re);
      console.log(`Ghi Ô0   ${describe(re)}`);
    }

    if (salesMa.length > 0 || clearedSalesMa.length > 0) {
      const rm = await this.service.writeSalesMa(salesMa, summary.salesMaDays, clearedSalesMa);
      this.accumulate(summary, rm);
      console.log(`Ghi MA${summary.salesMaDays}  ${describe(rm)}`);
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
    if (opts.only === 'sales-ma') {
      console.log(`Tháng ghi   ${toDateOnly(opts.ttTarget ?? opts.target).slice(0, 7)}  (cửa sổ trượt tính tới hôm nay)`);
    } else if (TT_ONLY.includes(opts.only)) {
      console.log(`Tháng TT    ${toDateOnly(opts.ttTarget ?? opts.target).slice(0, 7)}`);
    } else {
      console.log(`Tháng đích  ${periodStart}  (${daysInMonth(opts.target)} ngày)`);
    }
    if (!TT_ONLY.includes(opts.only)) {
      console.log(`Kiểu khối   ${CFG.blockMode}`);
      const blocks = this.service.blocksFor(opts.target);
      for (const b of blocks) {
        console.log(`  ${b.label.padEnd(26)} [${b.from} → ${b.to})  ${b.days} ngày  ×${b.weight}`);
      }
      console.log(
        `Công thức   FC = (Σ wᵢ·Bᵢ) / ${CFG.perDayDivisor} × ${daysInMonth(opts.target)}` +
        `   ·   MA3 = như FC với wᵢ = 1/3`,
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

function keyOf(r: { cnCode: string; skuCode: string; periodStart: string }): string {
  return `${r.cnCode}|${r.skuCode}|${r.periodStart}`;
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
