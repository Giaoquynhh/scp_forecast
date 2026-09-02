import {
  forecastQty, hasDemand, isDormant, movingAverage3, perDay, round2, weightedDemand,
  type Weights,
} from '../domain/forecast-formula.js';
import { buildBlocks, daysInMonth, toDateOnly, type BlockMode } from '../domain/period.js';
import {
  SALES_MA_DEFAULT_DAYS, SALES_MA_LOCK_DEFAULT, resolveSalesMaDays, salesMaMonthly,
} from '../domain/sales-ma.js';
import type {
  ActualLine, ForecastLine, ForecastRecord, ForecastWriter, PlanningConfigReader,
  SalesMaLine, SalesReader, WriteResult,
} from '../domain/types.js';

/** Ghi đè tham số công thức cho một lần tính. Trường bỏ trống thì lấy từ CFG. */
export interface FormulaOverride {
  weights?: Weights;
  blockMode?: BlockMode;
  perDayDivisor?: number;
  /** Tắt/bật ràng buộc "ngủ 2 tháng → FC = 0" cho một lần gọi (đường đọc/đối chứng). */
  zeroWhenDormant?: boolean;
}

/** Key trong `system_config` của SCP giữ cửa sổ TB trượt. Tên nói tháng, nghĩa là NGÀY. */
export const MA_DAYS_CONFIG_KEY = 'planning.ma_months';

export interface ForecastServiceDeps {
  sales: SalesReader;
  writer: ForecastWriter;
  /** Đọc `planning.ma_months`. Bỏ trống = luôn dùng mặc định 90 ngày. */
  config?: PlanningConfigReader;
  weights: Weights;
  blockMode: BlockMode;
  perDayDivisor: number;
  sourceFc: string;
  sourceTt: string;
  actor: string;
  /** Ràng buộc nghiệp vụ: 2 tháng gần nhất không bán → FC = 0. Xem isDormant(). */
  zeroWhenDormant: boolean;
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
      zeroWhenDormant: over?.zeroWhenDormant ?? this.deps.zeroWhenDormant,
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
      // Ràng buộc chỉ chạm FC. MA3 vẫn đi thẳng công thức để còn là mốc đối chiếu —
      // ô nào B1=B2=0 mà B3>0 sẽ ra FC = 0 vs MA3 = B3/3, và số bán thật nói ai đúng.
      const dormant = f.zeroWhenDormant && isDormant(t);
      const weighted = weightedDemand(t, f.weights);
      lines.push({
        cnCode: t.cnCode,
        skuCode: t.skuCode,
        periodStart,
        blocks: { b1: round2(t.b1), b2: round2(t.b2), b3: round2(t.b3) },
        weighted: round2(weighted),
        perDay: perDay(weighted, f.perDayDivisor),
        fcQty: dormant ? 0 : forecastQty(t, f.weights, f.perDayDivisor, days),
        ma3: movingAverage3(t, f.perDayDivisor, days),
      });
    }
    return lines;
  }

  /**
   * Tính TT cho khoảng tháng, kèm các nhóm cần chạm tới:
   *
   *  `cleared`  — cặp TỪNG có TT khác 0 nhưng kỳ này không còn bán. Bỏ qua thì số của
   *               lần chạy trước nằm lại vĩnh viễn.
   *  `unsold`   — cặp CÓ dự báo mà actual_qty còn trống VÀ tháng đó không bán gì. Trống
   *               ở đây KHÔNG phải "chưa biết" mà là "không bán được m² nào": lượt tính
   *               TT đã quét đúng khoảng tháng này và không thấy giao dịch nào.
   *  `unfilled` — cặp actual_qty còn TRỐNG mà tháng đó CÓ bán → lấp bằng số thật.
   *  `drift`    — cặp đã có số, nay không còn khớp sổ bán. KHÔNG sửa ở đây (xem dưới),
   *               chỉ đếm để lượt chạy nói ra thay vì im lặng.
   *
   * Bốn nhóm rời nhau theo cấu trúc nên gộp lại không thể trùng khoá trong một lượt
   * upsert: `cleared`/`drift` từ dòng ĐÃ có số, `unsold`/`unfilled` từ dòng CHƯA có —
   * và mỗi cặp lại chia nhau theo việc tháng đó có bán hay không.
   *
   * Vì sao `unsold` quan trọng: bên SCP `actual_qty IS NULL` bị loại khỏi mẫu chấm,
   * nên trước đây dự báo ra hàng mà bán 0 thì không bị phạt — mà đó chính là kiểu
   * trật nặng nhất. Cùng một sự thật "tháng này bán 0" mà chỗ lưu 0 (bị chấm 0%),
   * chỗ lưu NULL (được tha), chỉ vì cặp đó trước kia có bán hay không.
   *
   * Vì sao `unfilled` phải tách khỏi `actuals`: lấp ô trống và ghi đè số đã chốt là hai
   * việc khác nhau về hệ quả. Lượt `--only tt-close` được phép làm việc đầu (thêm thông
   * tin) mà không được làm việc sau (đổi số lịch sử) — trước đây nó chỉ lấp được ô trống
   * KHÔNG bán, còn ô trống CÓ bán thì không thuộc nhóm nào và nằm NULL vĩnh viễn. Đo
   * trên 2026-04..08: 326 cặp, 66.140 m² bán thật không bao giờ vào được bảng.
   *
   * Vì sao `drift` chỉ báo mà không sửa: sổ bán còn được nạp bù về sau, nên ghi đè tháng
   * đã chốt là quyết định vận hành, không phải hệ quả phụ của một lượt lấp chỗ trống.
   * Nhưng im lặng thì người đọc bảng tin rằng tháng cũ đã đối chiếu xong — nên phải nói.
   */
  async calculateActuals(
    fromMonth: string,
    toMonth: string,
  ): Promise<{
    actuals: ActualLine[];
    cleared: ActualLine[];
    unsold: ActualLine[];
    unfilled: ActualLine[];
    drift: { rows: number; net: number; abs: number };
  }> {
    const actuals = await this.deps.sales.monthlyActuals(fromMonth, toMonth);
    const present = new Set(actuals.map(keyOf));
    const existing = await this.deps.writer.pairsWithActuals(fromMonth, toMonth);
    const cleared = existing
      .filter((r) => !present.has(keyOf(r)))
      .map((r) => ({ ...r, actualQty: 0 }));

    const noActual = await this.deps.writer.pairsWithForecastNoActual(fromMonth, toMonth);
    const unsold = noActual
      .filter((r) => !present.has(keyOf(r)))
      .map((r) => ({ ...r, actualQty: 0 }));

    // `onRecord` gồm cả ô đang là 0: số 0 do lượt đóng sổ trước ghi vẫn là "đã có số",
    // không phải ô trống. Coi nó là trống thì mỗi lượt lại ghi đè nó, và ranh giới giữa
    // lấp chỗ trống với ghi đè số cũ biến mất.
    const onRecord = await this.deps.writer.actualsOnRecord(fromMonth, toMonth);
    const recorded = new Map(onRecord.map((r) => [keyOf(r), r.actualQty]));

    const unfilled: ActualLine[] = [];
    const drift = { rows: 0, net: 0, abs: 0 };
    for (const a of actuals) {
      const was = recorded.get(keyOf(a));
      if (was === undefined) {
        unfilled.push(a);
        continue;
      }
      if (was !== a.actualQty) {
        drift.rows += 1;
        drift.net += a.actualQty - was;
        drift.abs += Math.abs(a.actualQty - was);
      }
    }

    return { actuals, cleared, unsold, unfilled, drift };
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

  /**
   * Giữ bất biến: dòng nào có `fc_qty` thì cũng phải có `ma3`.
   *
   * Những dòng lệch mã hoá này không do engine tạo (job ghi TT insert dòng với
   * `fc_qty` mặc định 0, `ma3` để trống) nên `staleForecast` không thấy — nó chỉ
   * quét dòng có số KHÁC 0. Kết quả: bên SCP chấm FC 0% trên chúng, còn MA3 thì
   * được loại khỏi mẫu, và bảng đối chiếu FC vs MA3 lệch hẳn một bên.
   *
   * Ghi `ma3 = 0` chứ không phải NULL, vì với những cặp này 3 khối đầu vào đều
   * rỗng ⇒ MA3 đúng bằng 0. Nói "cả hai mô hình cùng dự báo 0" mới là sự thật;
   * để NULL là giả vờ MA3 không có ý kiến.
   *
   * KHÔNG truyền fcQty: upsert dùng COALESCE(EXCLUDED.fc_qty, cột cũ) nên bỏ trống
   * là giữ nguyên số cũ — không có đường nào dẫm lên FC ở đây.
   */
  async fillMissingMa3(periodStart: string, computed: ForecastLine[]): Promise<ForecastRecord[]> {
    const present = new Set(computed.map((l) => `${l.cnCode}|${l.skuCode}|${l.periodStart}`));
    const rows = await this.deps.writer.pairsMissingMa3(periodStart);
    return rows
      .filter((r) => !present.has(`${r.cnCode}|${r.skuCode}|${r.periodStart}`))
      .map((r) => ({ cnCode: r.cnCode, skuCode: r.skuCode, periodStart: r.periodStart, ma3: 0 }));
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
  /**
   * Dòng có TT mà bỏ trống `fc_qty` → điền `fc_qty = 0` VÀ `ma3 = 0`.
   *
   * Cùng một lý lẽ với `fillMissingMa3`, chỉ khác cột thiếu. Dòng do đường ghi TT tạo
   * ra không đặt cột dự báo nào, nhưng engine KHÔNG bỏ sót chúng: cổng `hasDemand()`
   * đã loại cặp đó vì cả 3 khối đầu vào rỗng, tức công thức cho ra
   * `0,6×0 + 0,3×0 + 0,1×0 = 0` cho FC và `(0+0+0)/3 = 0` cho MA3. Con số 0 ở đây là
   * KẾT QUẢ của công thức, không phải chỗ trống.
   *
   * Vì sao phải điền: bên SCP hằng SCORED đòi cả hai cột NOT NULL, nên dòng để trống
   * bị loại khỏi mẫu chấm — và đó là những cặp MỚI BẮT ĐẦU BÁN, tức dự báo trật hoàn
   * toàn (đặt 0, khách mua 736 m²) lại là loại duy nhất được miễn chấm. Nặng hơn: dòng
   * cũ của cùng tình huống đang lưu `fc_qty = 0` nên BỊ chấm 0%, dòng mới lưu NULL nên
   * được tha — cùng một sự thật, hai kết quả, chỉ vì hai đường ghi tạo dòng ở hai thời
   * điểm khác nhau. Đo trên 2026-04..08: 724 ô, 60.661 m² bán thật nằm ngoài mẫu.
   *
   * Chỉ gọi cho khoảng tháng mà engine ĐÃ chạy. Với tháng chưa tính FC, `fc_qty` trống
   * nghĩa là "chưa tính", và điền 0 ở đó là bịa ra một dự báo chưa tồn tại.
   */
  async fillMissingForecast(fromMonth: string, toMonth: string): Promise<ForecastRecord[]> {
    const rows = await this.deps.writer.pairsWithActualNoForecast(fromMonth, toMonth);
    return rows.map((r) => ({
      cnCode: r.cnCode,
      skuCode: r.skuCode,
      periodStart: r.periodStart,
      fcQty: 0,
      ma3: 0,
    }));
  }

  /**
   * Ô TRỐNG HẲN → tạo dòng với `fc_qty = ma3 = actual_qty = 0`.
   *
   * "Trống hẳn" = cặp CN×SKU có dòng ở tháng khác trong khoảng nhưng thiếu dòng ở tháng
   * này. Với chúng cả ba con số đều suy được CHẮC CHẮN, không phải phỏng đoán:
   *  - Engine đã chạy cho tháng đó (kiểm bằng `engineMonths`) mà không sinh dòng ⇒ cổng
   *    `hasDemand()` đã loại cặp ⇒ 3 khối rỗng ⇒ FC = MA3 = 0 theo đúng công thức.
   *  - Đường ghi TT cũng không sinh dòng ⇒ tháng đó không có giao dịch ⇒ TT = 0.
   *    `soldKeys` chặn thêm một lần: cặp nào có trong sổ bán thì KHÔNG được ghi 0.
   *
   * Vì sao phải tạo dòng thật thay vì để SCP tự hiểu: cùng một sự thật "không dự báo,
   * không bán" mà dòng CÓ trong DB thì bảng chấm 100% (quy tắc khớp hoàn hảo), dòng
   * KHÔNG có thì bảng hiện "—". Đo trên 2026-04..08: 1.542–2.515 ô/tháng ở nhóm đầu và
   * 10.659 ô ở nhóm sau — cùng nghĩa, hai cách hiện. Mọi con số dự báo phải do app sinh
   * ra, SCP chỉ đọc, nên chỗ xoá bất nhất này ở đây chứ không ở SCP.
   *
   * Ô như vậy VÔ TRỌNG LƯỢNG ở cấp CN/công ty: nó góp 0 vào Σtt và 0 vào Σ|lệch|, nên
   * không bơm được điểm của ai (đã đối chứng: bỏ chúng ra, số cấp tháng không đổi tới
   * 2 chữ số thập phân).
   */
  async fillEmptyCells(
    fromMonth: string,
    toMonth: string,
    soldKeys: ReadonlySet<string>,
  ): Promise<ForecastRecord[]> {
    const { cells, engineMonths } = await this.deps.writer.emptyCellsInWindow(fromMonth, toMonth);
    const ranByEngine = new Set(engineMonths);
    return cells
      .filter((c) => ranByEngine.has(c.periodStart))
      .filter((c) => !soldKeys.has(keyOf(c)))
      .map((c) => ({
        cnCode: c.cnCode,
        skuCode: c.skuCode,
        periodStart: c.periodStart,
        fcQty: 0,
        ma3: 0,
        actualQty: 0,
      }));
  }

  /** Ghi phần ô trống hẳn. KHÔNG updateOnly — đây là tạo dòng mới, có chủ đích. */
  async writeEmptyCells(records: ForecastRecord[]): Promise<WriteResult> {
    return this.deps.writer.write(records, {
      source: this.deps.sourceFc,
      changedBy: this.deps.actor,
      reason: 'Ô trống: không dự báo (3 khối rỗng), không bán → FC = MA3 = TT = 0',
    });
  }

  /** Ghi phần điền bù của `fillMissingForecast`. Chỉ sửa dòng đã có, không thêm dòng. */
  async writeZeroForecast(records: ForecastRecord[]): Promise<WriteResult> {
    return this.deps.writer.write(records, {
      source: this.deps.sourceFc,
      changedBy: this.deps.actor,
      reason: 'FC/MA3 = 0 cho cặp mới bán (3 khối đầu vào rỗng)',
      updateOnly: true,
      keepSource: true,
    });
  }

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

  // ── TB trượt bán n ngày (cột sales_ma_qty — F1-B3 bên SCP đọc) ────────────

  /**
   * Cửa sổ trượt của lượt này.
   *
   * `days` là cửa sổ THẬT SỰ dùng để tính — hiện luôn là 90 vì `SALES_MA_LOCK_DEFAULT`
   * đang bật. `requested` là con số người dùng đặt ở popup "Điều chỉnh tham số tính
   * toán" bên SCP. Trả về cả hai để lượt chạy NÓI RA khi chúng lệch: im lặng thì nhãn
   * cột ghi một đằng còn số là một nẻo, và đó là kiểu sai không ai phát hiện được.
   *
   * Đọc config mỗi lượt chứ không nhớ lại — daemon sống liên tục nhiều tuần.
   */
  async salesMaDays(): Promise<{ days: number; requested: number }> {
    const raw = this.deps.config
      ? await this.deps.config.value(MA_DAYS_CONFIG_KEY)
      : null;
    const requested = resolveSalesMaDays(raw);
    return {
      days: SALES_MA_LOCK_DEFAULT ? SALES_MA_DEFAULT_DAYS : requested,
      requested,
    };
  }

  /**
   * TB trượt bán `days` ngày gần nhất cho từng cặp CN×SKU, quy m²/THÁNG.
   *
   * `periodStart` là dòng ĐƯỢC GHI VÀO, không phải khoảng dữ liệu: cửa sổ luôn tính
   * tới hôm nay. Ghi vào dòng tháng đang chạy vì đó là "ảnh chụp tới hôm nay", và vì
   * dòng đó chắc chắn tồn tại (TT ghi mỗi ngày cho tháng hiện tại).
   *
   * KHÔNG có cổng `hasDemand`: cặp nào lọt vào truy vấn thì đã có bán trong cửa sổ.
   */
  async calculateSalesMa(periodStart: string, days: number): Promise<SalesMaLine[]> {
    const totals = await this.deps.sales.windowTotals(days);
    return totals.map((t) => ({
      cnCode: t.cnCode,
      skuCode: t.skuCode,
      periodStart,
      salesMaQty: salesMaMonthly(t.totalM2, days),
    }));
  }

  /**
   * Dòng đang có TB trượt khác 0 mà kỳ này đã rơi khỏi cửa sổ → đưa về 0.
   *
   * Không có bước này thì một cặp bán lần cuối cách đây 4 tháng vẫn giữ số cũ, và
   * F1-B3 (cộng cột này qua các CN rồi so với tồn) sẽ báo Khẩn cấp rồi đặt hàng cho
   * một mã đã ngừng bán. Ghi 0 chứ không NULL: "đã đo, kết quả bằng 0" khác "chưa đo".
   */
  async staleSalesMa(periodStart: string, computed: SalesMaLine[]): Promise<ForecastRecord[]> {
    const present = new Set(computed.map(keyOf));
    const existing = await this.deps.writer.pairsWithSalesMa(periodStart);
    return existing
      .filter((r) => !present.has(keyOf(r)))
      .map((r) => ({
        cnCode: r.cnCode, skuCode: r.skuCode, periodStart: r.periodStart, salesMaQty: 0,
      }));
  }

  /**
   * Ghi cột `sales_ma_qty`. `keepSource` vì cột này trực giao với FC: chạm vào một
   * dòng mà FC của nó do engine khác ghi thì không được đổi nhãn `source` của dòng.
   *
   * KHÔNG `updateOnly`: cặp có bán trong cửa sổ mà chưa có dòng thì phải tạo — bỏ qua
   * là mất hẳn nó khỏi tổng của F1-B3. (Đo 2026-08: chỉ 2 cặp, nhưng số 2 đó không
   * phải là hằng số.)
   */
  async writeSalesMa(
    lines: SalesMaLine[],
    days: number,
    cleared: ForecastRecord[] = [],
  ): Promise<WriteResult> {
    const records: ForecastRecord[] = [
      ...lines.map((l) => ({
        cnCode: l.cnCode,
        skuCode: l.skuCode,
        periodStart: l.periodStart,
        salesMaQty: l.salesMaQty,
      })),
      ...cleared,
    ];
    return this.deps.writer.write(records, {
      source: this.deps.sourceTt,
      changedBy: this.deps.actor,
      reason: `TB trượt bán ${days} ngày → m²/tháng`,
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

function keyOf(r: { cnCode: string; skuCode: string; periodStart: string }): string {
  return `${r.cnCode}|${r.skuCode}|${r.periodStart}`;
}
