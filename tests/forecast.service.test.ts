import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForecastService } from '../src/app/forecast.service.js';
import type {
  ActualLine, ForecastRecord, ForecastWriter, PairBlockTotals, PairWindowTotal,
  PlanningConfigReader, SalesReader, WriteOptions, WriteResult,
} from '../src/domain/types.js';

/**
 * Service phụ thuộc interface chứ không phụ thuộc Postgres, nên test được bằng
 * reader/writer giả — không cần DB, chạy trong vài mili giây.
 */
class FakeSales implements SalesReader {
  constructor(
    private readonly totals: PairBlockTotals[],
    private readonly actuals: ActualLine[] = [],
    private readonly window: PairWindowTotal[] = [],
  ) {}
  lastRanges: Array<{ from: string; to: string }> = [];
  lastWindowDays?: number;

  async blockTotals(ranges: Array<{ from: string; to: string }>): Promise<PairBlockTotals[]> {
    this.lastRanges = ranges;
    return this.totals;
  }
  async monthlyActuals(): Promise<ActualLine[]> { return this.actuals; }
  async windowTotals(days: number): Promise<PairWindowTotal[]> {
    this.lastWindowDays = days;
    return this.window;
  }
  async latestSalesDate(): Promise<string | null> { return null; }
}

class FakeConfig implements PlanningConfigReader {
  constructor(private readonly raw: string | null) {}
  async value(): Promise<string | null> { return this.raw; }
}

class FakeWriter implements ForecastWriter {
  written: ForecastRecord[] = [];
  lastOpts?: WriteOptions;
  constructor(
    private readonly existing: ActualLine[] = [],
    private readonly withForecast: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
    private readonly missingMa3: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
    private readonly forecastNoActual: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
    private readonly onRecord?: ActualLine[],
    private readonly actualNoForecast: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
    private readonly emptyCells: {
      cells: Array<{ cnCode: string; skuCode: string; periodStart: string }>;
      engineMonths: string[];
    } = { cells: [], engineMonths: [] },
    private readonly withSalesMa: Array<{ cnCode: string; skuCode: string; periodStart: string }> = [],
  ) {}

  async write(records: ForecastRecord[], opts: WriteOptions): Promise<WriteResult> {
    this.written.push(...records);
    this.lastOpts = opts;
    return { inserted: records.length, updated: 0, skipped: 0, notFound: 0 };
  }
  async pairsWithActuals(): Promise<ActualLine[]> { return this.existing; }
  async pairsWithForecast() { return this.withForecast; }
  async pairsMissingMa3() { return this.missingMa3; }
  async pairsWithForecastNoActual() { return this.forecastNoActual; }
  /** `existing` lọc `<> 0`; `onRecord` là mọi ô đã có số nên mặc định bằng nó. */
  async actualsOnRecord(): Promise<ActualLine[]> { return this.onRecord ?? this.existing; }
  async pairsWithActualNoForecast() { return this.actualNoForecast; }
  async emptyCellsInWindow() { return this.emptyCells; }
  async pairsWithSalesMa() { return this.withSalesMa; }
}

function buildWith(
  sales: SalesReader,
  writer: ForecastWriter,
  zeroWhenDormant: boolean,
): ForecastService {
  return new ForecastService({
    sales, writer, weights: [0.6, 0.3, 0.1], blockMode: 'calendar', perDayDivisor: 30,
    sourceFc: 'FORECAST_ENGINE', sourceTt: 'SALES_V2_BACKFILL', actor: 'test',
    zeroWhenDormant,
  });
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
    zeroWhenDormant: true,
  });
}

const T = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01, tháng 30 ngày

/** assert.equal cho số có làm tròn 2 chữ số. */
function expect0(got: number, want: number): void {
  assert.equal(round(got), round(want));
}
const round = (n: number) => Math.round(n * 100) / 100;

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

  // Ràng buộc nghiệp vụ: ngủ 2 tháng gần nhất (B1, B2) thì FC = 0, dù B3 còn số.
  // Không có nó thì mã bán lần cuối cách đây 3 tháng vẫn được dự báo 0,1×B3.
  it('B1 = B2 = 0 → FC = 0, nhưng MA3 GIỮ NGUYÊN (baseline không đổi)', async () => {
    const sales = new FakeSales([
      { cnCode: '093', skuCode: 'SKU-NGU', b1: 0, b2: 0, b3: 4800 },
    ]);
    const [line] = await build(sales, new FakeWriter()).calculateForecast(T);

    expect0(line.fcQty, 0);
    // MA3 = (0+0+4800)/3 = 1600, /30 × 30 ngày = 1600 — không bị ràng buộc chạm vào.
    expect0(line.ma3, 1600);
    // Vẫn tạo dòng (hasDemand true nhờ B3) để ô đó còn được chấm điểm.
    expect0(line.blocks.b3, 4800);
  });

  it('chỉ B1 = 0 (B2 còn bán) → KHÔNG phải ngủ, FC tính bình thường', async () => {
    const sales = new FakeSales([
      { cnCode: '093', skuCode: 'SKU-A', b1: 0, b2: 300, b3: 150 },
    ]);
    const [line] = await build(sales, new FakeWriter()).calculateForecast(T);
    expect0(line.fcQty, 105); // 0,3×300 + 0,1×150 = 105
  });

  it('tắt ràng buộc thì FC quay lại 0,1×B3 — để đối chứng có/không', async () => {
    const sales = new FakeSales([
      { cnCode: '093', skuCode: 'SKU-NGU', b1: 0, b2: 0, b3: 4800 },
    ]);
    const [line] = await buildWith(sales, new FakeWriter(), false).calculateForecast(T);
    expect0(line.fcQty, 480); // 0,1 × 4800
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

  // Dòng có dự báo mà actual_qty còn trống: trống = bán 0, không phải "chưa biết".
  // Để NULL thì bên SCP loại khỏi mẫu ⇒ dự báo ra hàng mà bán 0 không bị chấm.
  it('đóng sổ 0 cho cặp có dự báo mà tháng đó không bán được gì', async () => {
    const sales = new FakeSales([], []);
    const writer = new FakeWriter([], [], [], [
      { cnCode: '093', skuCode: 'SKU-KHONG-BAN', periodStart: '2026-09-01' },
    ]);
    const res = await build(sales, writer).calculateActuals('2026-09-01', '2026-09-01');

    assert.deepEqual(res.unsold, [
      { cnCode: '093', skuCode: 'SKU-KHONG-BAN', periodStart: '2026-09-01', actualQty: 0 },
    ]);
    assert.deepEqual(res.cleared, []); // dòng NULL không thuộc nhóm cleared
  });

  it('không đóng sổ cặp kỳ này CÓ bán — số thật thắng', async () => {
    const sales = new FakeSales([], [
      { cnCode: '093', skuCode: 'SKU-A', periodStart: '2026-09-01', actualQty: 120 },
    ]);
    const writer = new FakeWriter([], [], [], [
      { cnCode: '093', skuCode: 'SKU-A', periodStart: '2026-09-01' },
    ]);
    const res = await build(sales, writer).calculateActuals('2026-09-01', '2026-09-01');

    assert.deepEqual(res.unsold, []);
    assert.equal(res.actuals[0].actualQty, 120);
  });

  it('cleared, unsold và unfilled không bao giờ trùng khoá (một lượt upsert an toàn)', async () => {
    const sales = new FakeSales([], [
      { cnCode: '093', skuCode: 'SKU-TRONG', periodStart: '2026-09-01', actualQty: 77 },
    ]);
    const writer = new FakeWriter(
      [{ cnCode: '093', skuCode: 'SKU-CU', periodStart: '2026-09-01', actualQty: 999 }],
      [], [],
      [{ cnCode: '093', skuCode: 'SKU-MOI', periodStart: '2026-09-01' }],
    );
    const res = await build(sales, writer).calculateActuals('2026-09-01', '2026-09-01');
    const keys = [...res.cleared, ...res.unsold, ...res.unfilled]
      .map((r) => `${r.cnCode}|${r.skuCode}|${r.periodStart}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  // Đây là lỗ đã làm mất 66.140 m² của 2026-04..08: ô trống mà tháng đó CÓ bán không
  // thuộc `unsold` (nhóm đó lọc "không bán") nên mode 'tt-close' không chạm tới, và
  // cũng không được ghi vì 'tt-close' bỏ `actuals` ⇒ nằm NULL vĩnh viễn.
  it('ô actual_qty trống mà tháng đó CÓ bán → vào unfilled để tt-close lấp được', async () => {
    const sales = new FakeSales([], [
      { cnCode: '093', skuCode: 'SKU-CO-BAN', periodStart: '2026-04-01', actualQty: 1198.5 },
    ]);
    // Ô này có dự báo, chưa có TT, và sổ bán có 1.198,5 m² — đúng ca 093/SVICC504.
    const writer = new FakeWriter([], [], [], [
      { cnCode: '093', skuCode: 'SKU-CO-BAN', periodStart: '2026-04-01' },
    ]);
    const res = await build(sales, writer).calculateActuals('2026-04-01', '2026-04-01');

    assert.deepEqual(res.unfilled, [
      { cnCode: '093', skuCode: 'SKU-CO-BAN', periodStart: '2026-04-01', actualQty: 1198.5 },
    ]);
    assert.deepEqual(res.unsold, []); // có bán thì không phải "bán 0"
    assert.equal(res.drift.rows, 0);  // chưa có số cũ nào để lệch
  });

  it('ô ĐÃ có số nay lệch sổ bán → chỉ vào drift, không vào unfilled', async () => {
    const sales = new FakeSales([], [
      { cnCode: '093', skuCode: 'SKU-A', periodStart: '2026-05-01', actualQty: 1344 },
    ]);
    const writer = new FakeWriter(
      [{ cnCode: '093', skuCode: 'SKU-A', periodStart: '2026-05-01', actualQty: 1200 }],
      [], [], [],
    );
    const res = await build(sales, writer).calculateActuals('2026-05-01', '2026-05-01');

    assert.deepEqual(res.unfilled, []);
    assert.equal(res.drift.rows, 1);
    assert.equal(res.drift.net, 144);
    assert.equal(res.drift.abs, 144);
  });

  // Số 0 do lượt đóng sổ trước ghi vẫn là "đã có số". Coi nó là ô trống thì mỗi lượt
  // 'tt-close' lại ghi đè nó, và ranh giới với việc ghi đè số cũ biến mất.
  it('ô đang là 0 không bị coi là trống — vào drift chứ không vào unfilled', async () => {
    const sales = new FakeSales([], [
      { cnCode: '093', skuCode: 'SKU-A', periodStart: '2026-05-01', actualQty: 500 },
    ]);
    const writer = new FakeWriter(
      [], [], [], [],
      [{ cnCode: '093', skuCode: 'SKU-A', periodStart: '2026-05-01', actualQty: 0 }],
    );
    const res = await build(sales, writer).calculateActuals('2026-05-01', '2026-05-01');

    assert.deepEqual(res.unfilled, []);
    assert.equal(res.drift.rows, 1);
    assert.equal(res.drift.net, 500);
  });
});

// Dòng do đường ghi TT tạo không có cột dự báo nào. Với chúng 3 khối đầu vào rỗng nên
// công thức cho đúng 0 — để NULL thì bên SCP loại ô khỏi mẫu, và cặp mới bắt đầu bán
// (trật nặng nhất) thành loại duy nhất được miễn chấm.
describe('ForecastService.fillMissingForecast', () => {
  it('điền CẢ fc_qty = 0 lẫn ma3 = 0 cho dòng có TT mà trống dự báo', async () => {
    const writer = new FakeWriter([], [], [], [], undefined, [
      { cnCode: '093', skuCode: 'SKU-MOI-BAN', periodStart: '2026-04-01' },
    ]);
    const recs = await build(new FakeSales([]), writer).fillMissingForecast('2026-04-01', '2026-04-01');

    assert.deepEqual(recs, [
      { cnCode: '093', skuCode: 'SKU-MOI-BAN', periodStart: '2026-04-01', fcQty: 0, ma3: 0 },
    ]);
  });

  it('không có dòng nào thiếu dự báo → không ghi gì', async () => {
    const recs = await build(new FakeSales([]), new FakeWriter())
      .fillMissingForecast('2026-04-01', '2026-04-01');
    assert.deepEqual(recs, []);
  });

  it('ghi bằng updateOnly để không tạo dòng mới ở tháng đã chốt', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales([]), writer).writeZeroForecast([
      { cnCode: '093', skuCode: 'A', periodStart: '2026-04-01', fcQty: 0, ma3: 0 },
    ]);
    assert.equal(writer.lastOpts?.updateOnly, true);
    assert.equal(writer.lastOpts?.keepSource, true);
  });
});

// Ô trống hẳn: cặp có dòng ở tháng khác nhưng thiếu dòng ở tháng này. Cùng một sự thật
// "không dự báo, không bán" mà dòng CÓ thì bảng chấm 100%, dòng KHÔNG thì hiện "—".
describe('ForecastService.fillEmptyCells', () => {
  const cell = (sku: string, ps: string) => ({ cnCode: '093', skuCode: sku, periodStart: ps });

  it('tạo dòng FC = MA3 = TT = 0 cho ô trống của tháng engine ĐÃ chạy', async () => {
    const writer = new FakeWriter([], [], [], [], undefined, [], {
      cells: [cell('SKU-IM-LANG', '2026-04-01')],
      engineMonths: ['2026-04-01'],
    });
    const recs = await build(new FakeSales([]), writer)
      .fillEmptyCells('2026-04-01', '2026-04-01', new Set());

    assert.deepEqual(recs, [{
      cnCode: '093', skuCode: 'SKU-IM-LANG', periodStart: '2026-04-01',
      fcQty: 0, ma3: 0, actualQty: 0,
    }]);
  });

  // Tháng engine chưa chạy thì "thiếu dòng" nghĩa là CHƯA TÍNH, không phải "dự báo 0".
  // Ghi 0 ở đó biến cả tháng thành "dự báo hoàn hảo 100%" trên toàn bảng.
  it('BỎ QUA tháng engine chưa chạy', async () => {
    const writer = new FakeWriter([], [], [], [], undefined, [], {
      cells: [cell('A', '2026-04-01'), cell('B', '2026-09-01')],
      engineMonths: ['2026-04-01'], // tháng 9 chưa có dòng nào của engine
    });
    const recs = await build(new FakeSales([]), writer)
      .fillEmptyCells('2026-04-01', '2026-09-01', new Set());

    assert.equal(recs.length, 1);
    assert.equal(recs[0].skuCode, 'A');
  });

  // Chặn tầng hai: cặp có trong sổ bán thì TT không thể là 0.
  it('BỎ QUA cặp có mặt trong sổ bán', async () => {
    const writer = new FakeWriter([], [], [], [], undefined, [], {
      cells: [cell('A', '2026-04-01'), cell('CO-BAN', '2026-04-01')],
      engineMonths: ['2026-04-01'],
    });
    const recs = await build(new FakeSales([]), writer)
      .fillEmptyCells('2026-04-01', '2026-04-01', new Set(['093|CO-BAN|2026-04-01']));

    assert.equal(recs.length, 1);
    assert.equal(recs[0].skuCode, 'A');
  });

  it('ghi ô trống là TẠO dòng mới nên không được updateOnly', async () => {
    const writer = new FakeWriter();
    await build(new FakeSales([]), writer).writeEmptyCells([
      { cnCode: '093', skuCode: 'A', periodStart: '2026-04-01', fcQty: 0, ma3: 0, actualQty: 0 },
    ]);
    assert.equal(writer.lastOpts?.updateOnly, undefined);
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

// Bất biến: dòng nào có fc_qty thì cũng phải có ma3. Dòng lệch mã hoá (fc_qty = 0
// mặc định do job ghi TT tạo, ma3 NULL) làm bên SCP chấm FC 0% còn MA3 được miễn.
describe('ForecastService.fillMissingMa3', () => {
  const computed = [{
    cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01',
    blocks: { b1: 1, b2: 1, b3: 1 }, weighted: 1, perDay: 1, fcQty: 30, ma3: 1,
  }];

  it('điền ma3 = 0 và KHÔNG đụng fc_qty (bỏ trống để upsert giữ số cũ)', async () => {
    const writer = new FakeWriter([], [], [
      { cnCode: '073', skuCode: 'SKU-MOI', periodStart: '2026-09-01' },
    ]);
    const service = build(new FakeSales([]), writer);
    const res = await service.fillMissingMa3('2026-09-01', computed);

    assert.deepEqual(res, [
      { cnCode: '073', skuCode: 'SKU-MOI', periodStart: '2026-09-01', ma3: 0 },
    ]);
    assert.equal('fcQty' in res[0], false); // có mặt fcQty là dẫm lên FC
  });

  it('bỏ qua dòng engine vừa tính — chúng sắp được ghi ma3 thật', async () => {
    const writer = new FakeWriter([], [], [
      { cnCode: '073', skuCode: 'SKU-A', periodStart: '2026-09-01' },
    ]);
    const service = build(new FakeSales([]), writer);
    assert.deepEqual(await service.fillMissingMa3('2026-09-01', computed), []);
  });

  it('không có dòng lệch thì không ghi gì', async () => {
    const service = build(new FakeSales([]), new FakeWriter());
    assert.deepEqual(await service.fillMissingMa3('2026-09-01', computed), []);
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
