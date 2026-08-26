import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForecastService } from '../src/app/forecast.service.js';
import type {
  ActualLine, ForecastRecord, ForecastWriter, PairBlockTotals, SalesReader, WriteOptions, WriteResult,
} from '../src/domain/types.js';

/**
 * Service phụ thuộc interface chứ không phụ thuộc Postgres, nên test được bằng
 * reader/writer giả — không cần DB, chạy trong vài mili giây.
 */
class FakeSales implements SalesReader {
  constructor(
    private readonly totals: PairBlockTotals[],
    private readonly actuals: ActualLine[] = [],
  ) {}
  lastRanges: Array<{ from: string; to: string }> = [];

  async blockTotals(ranges: Array<{ from: string; to: string }>): Promise<PairBlockTotals[]> {
    this.lastRanges = ranges;
    return this.totals;
  }
  async monthlyActuals(): Promise<ActualLine[]> { return this.actuals; }
  async latestSalesDate(): Promise<string | null> { return null; }
}

class FakeWriter implements ForecastWriter {
  written: ForecastRecord[] = [];
  lastOpts?: WriteOptions;
  constructor(
    private readonly existing: ActualLine[] = [],
    private readonly withForecast: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
  ) {}

  async write(records: ForecastRecord[], opts: WriteOptions): Promise<WriteResult> {
    this.written.push(...records);
    this.lastOpts = opts;
    return { inserted: records.length, updated: 0, skipped: 0, notFound: 0 };
  }
  async pairsWithActuals(): Promise<ActualLine[]> { return this.existing; }
  async pairsWithForecast() { return this.withForecast; }
}

function build(sales: SalesReader, writer: ForecastWriter): ForecastService {
  return new ForecastService({
    sales,
    writer,
    weights: [0.6, 0.3, 0.1],
    blockMode: 'calendar',
    perDayDivisor: 30,
    sourceFc: 'FORECAST_ENGINE',
    sourceTt: 'SALES_V2_BACKFILL',
    actor: 'test',
  });
}

const T = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01, tháng 30 ngày

describe('ForecastService.calculateForecast', () => {
  it('lấy đúng 3 tháng dương lịch liền trước tháng đích', async () => {
    const sales = new FakeSales([]);
    await build(sales, new FakeWriter()).calculateForecast(T);
    assert.deepEqual(sales.lastRanges, [
      { from: '2026-08-01', to: '2026-09-01' },
      { from: '2026-07-01', to: '2026-08-01' },
      { from: '2026-06-01', to: '2026-07-01' },
    ]);
  });

  it('tính FC và MA3 cho từng cặp', async () => {
    const sales = new FakeSales([
      { cnCode: '073', skuCode: 'SKU-A', b1: 310, b2: 300, b3: 150 },
    ]);
    const [line] = await build(sales, new FakeWriter()).calculateForecast(T);
    assert.equal(line.weighted, 291);
    assert.equal(line.fcQty, 291);      // perDay 9.7 × 30 ngày
    assert.equal(line.ma3, 253.33);
    assert.equal(line.periodStart, '2026-09-01');
  });

  it('bỏ cặp không bán gì trong cả 3 khối', async () => {
    const sales = new FakeSales([
      { cnCode: '073', skuCode: 'SKU-A', b1: 0, b2: 0, b3: 0 },
      { cnCode: '073', skuCode: 'SKU-B', b1: 10, b2: 0, b3: 0 },
    ]);
    const lines = await build(sales, new FakeWriter()).calculateForecast(T);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].skuCode, 'SKU-B');
  });
});

describe('ForecastService.calculateActuals', () => {
  it('đưa về 0 những cặp từng có TT nhưng kỳ này không còn bán', async () => {
    const sales = new FakeSales([], [
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01', actualQty: 50 },
    ]);
    const writer = new FakeWriter([
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01', actualQty: 50 },
      { cnCode: '073', skuCode: 'SKU-CU', periodStart: '2026-09-01', actualQty: 999 },
    ]);
    const res = await build(sales, writer).calculateActuals('2026-09-01', '2026-09-01');
    assert.equal(res.actuals.length, 1);
    assert.deepEqual(res.cleared, [
      { cnCode: '073', skuCode: 'SKU-CU', periodStart: '2026-09-01', actualQty: 0 },
    ]);
  });
});

describe('ForecastService.staleForecast', () => {
  it('đưa về 0 dòng còn FC cũ nhưng kỳ này không còn bán', async () => {
    const writer = new FakeWriter([], [
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01' },
      { cnCode: '073', skuCode: 'SKU-CU', periodStart: '2026-09-01' },
    ]);
    const service = build(new FakeSales([]), writer);
    const computed = [{
      cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01',
      blocks: { b1: 1, b2: 1, b3: 1 }, weighted: 1, perDay: 1, fcQty: 30, ma3: 1,
    }];
    assert.deepEqual(await service.staleForecast('2026-09-01', computed), [
      { cnCode: '073', skuCode: 'SKU-CU', periodStart: '2026-09-01', fcQty: 0, ma3: 0 },
    ]);
  });

  it('không đụng dòng vẫn còn bán', async () => {
    const writer = new FakeWriter([], [
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01' },
    ]);
    const service = build(new FakeSales([]), writer);
    const computed = [{
      cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01',
      blocks: { b1: 1, b2: 1, b3: 1 }, weighted: 1, perDay: 1, fcQty: 30, ma3: 1,
    }];
    assert.deepEqual(await service.staleForecast('2026-09-01', computed), []);
  });
});

describe('ForecastService.writeForecast', () => {
  it('chỉ ghi fc_qty và ma3, không đụng actual_qty', async () => {
    const writer = new FakeWriter();
    const service = build(new FakeSales([]), writer);
    await service.writeForecast(
      [{
        cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01',
        blocks: { b1: 1, b2: 1, b3: 1 }, weighted: 1, perDay: 1, fcQty: 30, ma3: 1,
      }],
      '2026-09-01',
    );
    assert.deepEqual(writer.written, [
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01', fcQty: 30, ma3: 1 },
    ]);
    assert.equal(writer.lastOpts?.source, 'FORECAST_ENGINE');
  });
});

describe('ForecastService.writeMa3', () => {
  const line = {
    cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-03-01',
    blocks: { b1: 1, b2: 1, b3: 1 }, weighted: 1, perDay: 1, fcQty: 30, ma3: 1,
  };

  it('CHỈ gửi ma3 — không gửi fcQty, để COALESCE giữ nguyên FC của engine cũ', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales([]), writer).writeMa3([line], '2026-03-01');

    assert.deepEqual(writer.written, [
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-03-01', ma3: 1 },
    ]);
    // Không có khóa fcQty, khác hẳn với "fcQty: undefined" — repository đọc
    // `r.fcQty ?? null` nên cả hai ra NULL, nhưng vắng mặt hẳn thì rõ ý hơn.
    assert.equal('fcQty' in writer.written[0], false);
  });

  it('bật updateOnly và keepSource', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales([]), writer).writeMa3([line], '2026-03-01');

    assert.equal(writer.lastOpts?.updateOnly, true);
    assert.equal(writer.lastOpts?.keepSource, true);
  });

  it('reason nói rõ là điền bù, để phân biệt với lượt FC+MA3 trong lịch sử', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales([]), writer).writeMa3([line], '2026-03-01');

    assert.match(writer.lastOpts?.reason ?? '', /MA3 điền bù/);
  });

  it('dòng cleared cũng chỉ đưa ma3 về 0, không đụng fc', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales([]), writer).writeMa3([], '2026-03-01', [
      { cnCode: '073', skuCode: 'SKU-B', periodStart: '2026-03-01', fcQty: 0, ma3: 0 },
    ]);

    assert.deepEqual(writer.written, [
      { cnCode: '073', skuCode: 'SKU-B', periodStart: '2026-03-01', ma3: 0 },
    ]);
    assert.equal('fcQty' in writer.written[0], false);
  });
});
