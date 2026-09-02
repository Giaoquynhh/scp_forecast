import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DAYS_PER_MONTH, SALES_MA_DEFAULT_DAYS, SALES_MA_LOCK_DEFAULT, SALES_MA_MAX_DAYS,
  resolveSalesMaDays, salesMaMonthly,
} from '../src/domain/sales-ma.js';
import { ForecastService } from '../src/app/forecast.service.js';
import type {
  ActualLine, ForecastRecord, ForecastWriter, PairBlockTotals, PairWindowTotal,
  PlanningConfigReader, SalesReader, WriteOptions, WriteResult,
} from '../src/domain/types.js';

// ── hàm thuần ──────────────────────────────────────────────────────────────

describe('resolveSalesMaDays', () => {
  it('thiếu / rỗng / không phải số → mặc định 90', () => {
    for (const raw of [null, undefined, '', 'abc', {}]) {
      assert.equal(resolveSalesMaDays(raw), SALES_MA_DEFAULT_DAYS);
    }
  });

  it('số không nguyên hoặc < 1 → mặc định, không làm tròn bừa', () => {
    assert.equal(resolveSalesMaDays('45.5'), SALES_MA_DEFAULT_DAYS);
    assert.equal(resolveSalesMaDays('0'), SALES_MA_DEFAULT_DAYS);
    assert.equal(resolveSalesMaDays('-30'), SALES_MA_DEFAULT_DAYS);
  });

  it('nhận chuỗi số nguyên hợp lệ', () => {
    assert.equal(resolveSalesMaDays('30'), 30);
    assert.equal(resolveSalesMaDays('90'), 90);
    assert.equal(resolveSalesMaDays(120), 120);
  });

  it('vượt trần thì kẹp — phải khớp MA_TT_MAX_DAYS của SCP', () => {
    assert.equal(SALES_MA_MAX_DAYS, 150);
    assert.equal(resolveSalesMaDays('200'), 150);
    assert.equal(resolveSalesMaDays('150'), 150);
  });
});

describe('salesMaMonthly', () => {
  it('quy m²/ngày về m²/tháng bằng hằng số 30 (khớp DAYS_PER_MONTH của SCP)', () => {
    assert.equal(DAYS_PER_MONTH, 30);
    // 9.000 m² trong 90 ngày = 100 m²/ngày = 3.000 m²/tháng
    assert.equal(salesMaMonthly(9000, 90), 3000);
  });

  it('mẫu số là CẢ cửa sổ, không phải số ngày có bán', () => {
    // Bán trọn 300 m² trong đúng một ngày, cửa sổ 90 ngày → 100, không phải 9.000.
    assert.equal(salesMaMonthly(300, 90), 100);
  });

  it('làm tròn 2 chữ số khớp numeric(15,2)', () => {
    assert.equal(salesMaMonthly(100, 90), 33.33);
    assert.equal(salesMaMonthly(0, 90), 0);
  });

  it('đổi cửa sổ thì đổi số — 30 ngày nhìn nhạy hơn 90 ngày', () => {
    assert.equal(salesMaMonthly(900, 30), 900);
    assert.equal(salesMaMonthly(900, 90), 300);
  });

  it('cửa sổ <= 0 là lỗi lập trình, không phải chia cho 0 âm thầm', () => {
    assert.throws(() => salesMaMonthly(100, 0), RangeError);
  });
});

// ── service ────────────────────────────────────────────────────────────────

class FakeSales implements SalesReader {
  lastWindowDays?: number;
  constructor(private readonly window: PairWindowTotal[] = []) {}
  async blockTotals(): Promise<PairBlockTotals[]> { return []; }
  async monthlyActuals(): Promise<ActualLine[]> { return []; }
  async windowTotals(days: number): Promise<PairWindowTotal[]> {
    this.lastWindowDays = days;
    return this.window;
  }
  async latestSalesDate(): Promise<string | null> { return null; }
}

class FakeWriter implements ForecastWriter {
  written: ForecastRecord[] = [];
  lastOpts?: WriteOptions;
  constructor(
    private readonly withSalesMa: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
  ) {}
  async write(records: ForecastRecord[], opts: WriteOptions): Promise<WriteResult> {
    this.written.push(...records);
    this.lastOpts = opts;
    return { inserted: records.length, updated: 0, skipped: 0, notFound: 0 };
  }
  async pairsWithActuals(): Promise<ActualLine[]> { return []; }
  async pairsWithForecast() { return []; }
  async pairsMissingMa3() { return []; }
  async pairsWithForecastNoActual() { return []; }
  async actualsOnRecord(): Promise<ActualLine[]> { return []; }
  async pairsWithActualNoForecast() { return []; }
  async emptyCellsInWindow() { return { cells: [], engineMonths: [] }; }
  async pairsWithSalesMa() { return this.withSalesMa; }
}

class FakeConfig implements PlanningConfigReader {
  asked: string[] = [];
  constructor(private readonly raw: string | null) {}
  async value(key: string): Promise<string | null> {
    this.asked.push(key);
    return this.raw;
  }
}

function build(
  sales: SalesReader,
  writer: ForecastWriter,
  config?: PlanningConfigReader,
): ForecastService {
  return new ForecastService({
    sales, writer, config,
    weights: [0.6, 0.3, 0.1], blockMode: 'calendar', perDayDivisor: 30,
    sourceFc: 'FORECAST_ENGINE', sourceTt: 'SALES_V2_BACKFILL', actor: 'test',
    zeroWhenDormant: true,
  });
}

const P = '2026-08-01';

describe('ForecastService.salesMaDays', () => {
  it('KHOÁ CỨNG 90: người dùng đặt n bao nhiêu cũng tính bằng 90', async () => {
    assert.equal(SALES_MA_LOCK_DEFAULT, true);
    const cfg = new FakeConfig('45');
    const { days, requested } = await build(new FakeSales(), new FakeWriter(), cfg).salesMaDays();
    assert.equal(days, 90);
    // Vẫn đọc và trả về con số người dùng đặt, để lượt chạy cảnh báo được khi lệch.
    assert.equal(requested, 45);
    assert.deepEqual(cfg.asked, ['planning.ma_months']);
  });

  it('config hỏng hoặc không có reader → 90, lượt chạy vẫn tiếp tục', async () => {
    const a = await build(new FakeSales(), new FakeWriter(), new FakeConfig(null)).salesMaDays();
    const b = await build(new FakeSales(), new FakeWriter()).salesMaDays();
    assert.deepEqual(a, { days: 90, requested: 90 });
    assert.deepEqual(b, { days: 90, requested: 90 });
  });
});

describe('ForecastService.calculateSalesMa', () => {
  it('mỗi cặp CN×SKU ra m²/tháng, gắn vào dòng được chỉ định', async () => {
    const sales = new FakeSales([
      { cnCode: '049', skuCode: 'A', totalM2: 9000 },
      { cnCode: '050', skuCode: 'A', totalM2: 450 },
    ]);
    const lines = await build(sales, new FakeWriter()).calculateSalesMa(P, 90);

    assert.equal(sales.lastWindowDays, 90);
    assert.deepEqual(lines, [
      { cnCode: '049', skuCode: 'A', periodStart: P, salesMaQty: 3000 },
      { cnCode: '050', skuCode: 'A', periodStart: P, salesMaQty: 150 },
    ]);
  });

  it('cộng qua CN ra đúng số toàn quốc — đây là phép F1-B3 làm khi gộp theo sku', async () => {
    // Rải theo CN rồi cộng lại phải bằng tính một lần trên tổng: phép trượt tuyến tính.
    const sales = new FakeSales([
      { cnCode: '049', skuCode: 'A', totalM2: 9000 },
      { cnCode: '050', skuCode: 'A', totalM2: 450 },
    ]);
    const lines = await build(sales, new FakeWriter()).calculateSalesMa(P, 90);
    const perCn = lines.reduce((s, l) => s + l.salesMaQty, 0);
    assert.equal(perCn, salesMaMonthly(9000 + 450, 90));
  });

  it('không có bán trong cửa sổ → không dòng nào', async () => {
    const lines = await build(new FakeSales([]), new FakeWriter()).calculateSalesMa(P, 90);
    assert.deepEqual(lines, []);
  });
});

describe('ForecastService.staleSalesMa', () => {
  it('cặp rơi khỏi cửa sổ được đưa về 0, cặp còn bán thì không đụng', async () => {
    const writer = new FakeWriter([
      { cnCode: '049', skuCode: 'A', periodStart: P },  // còn bán
      { cnCode: '049', skuCode: 'B', periodStart: P },  // đã ngừng
    ]);
    const computed = [{ cnCode: '049', skuCode: 'A', periodStart: P, salesMaQty: 3000 }];

    const stale = await build(new FakeSales(), writer).staleSalesMa(P, computed);
    assert.deepEqual(stale, [
      { cnCode: '049', skuCode: 'B', periodStart: P, salesMaQty: 0 },
    ]);
  });

  it('ghi 0 chứ không NULL — "đã đo, bằng 0" khác "chưa đo"', async () => {
    const writer = new FakeWriter([{ cnCode: '049', skuCode: 'B', periodStart: P }]);
    const [row] = await build(new FakeSales(), writer).staleSalesMa(P, []);
    assert.equal(row.salesMaQty, 0);
    assert.notEqual(row.salesMaQty, null);
  });
});

describe('ForecastService.writeSalesMa', () => {
  it('chỉ truyền salesMaQty — bỏ trống các cột kia để upsert COALESCE giữ nguyên', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales(), writer).writeSalesMa(
      [{ cnCode: '049', skuCode: 'A', periodStart: P, salesMaQty: 3000 }],
      90,
    );

    assert.deepEqual(writer.written, [
      { cnCode: '049', skuCode: 'A', periodStart: P, salesMaQty: 3000 },
    ]);
    for (const r of writer.written) {
      assert.equal(r.fcQty, undefined);
      assert.equal(r.ma3, undefined);
      assert.equal(r.actualQty, undefined);
    }
  });

  it('keepSource: cột này trực giao với FC, không được đổi nhãn source của dòng', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales(), writer).writeSalesMa(
      [{ cnCode: '049', skuCode: 'A', periodStart: P, salesMaQty: 1 }], 90,
    );
    assert.equal(writer.lastOpts?.keepSource, true);
  });

  it('KHÔNG updateOnly: cặp mới bán mà chưa có dòng vẫn phải được tạo', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales(), writer).writeSalesMa(
      [{ cnCode: '049', skuCode: 'A', periodStart: P, salesMaQty: 1 }], 90,
    );
    assert.notEqual(writer.lastOpts?.updateOnly, true);
  });

  it('lý do ghi vào lịch sử nói rõ cửa sổ bao nhiêu ngày', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales(), writer).writeSalesMa([], 45, [
      { cnCode: '049', skuCode: 'B', periodStart: P, salesMaQty: 0 },
    ]);
    assert.match(writer.lastOpts?.reason ?? '', /45 ngày/);
    assert.equal(writer.written.length, 1);
  });
});
