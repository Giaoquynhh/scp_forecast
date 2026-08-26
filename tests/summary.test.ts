import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadQueryError, currentMonth, emptySummaryRow, parseBool, parseCsvList,
  parseGroupBy, parseSummaryQuery, pct, toSummaryRow,
  type SummaryAggregate, type SummaryQuery, type SummaryReader,
} from '../src/domain/summary.js';
import { SummaryService } from '../src/app/summary.service.js';

/** Số thô mặc định — mỗi test chỉ ghi đè phần mình quan tâm. */
function agg(over: Partial<SummaryAggregate> = {}): SummaryAggregate {
  return {
    cnCode: null, cnName: null, region: null, month: null,
    fcQty: null, ma3Qty: null, actualQty: null,
    fcAbsErr: null, actualComparable: null, ma3AbsErr: null, actualComparableMa3: null,
    rowCount: 0, skuCount: 0, cnCount: 0, ma3RowCount: 0, comparableRowCount: 0,
    ...over,
  };
}

describe('pct', () => {
  test('chia bình thường, làm tròn 2 chữ số', () => {
    assert.equal(pct(291, 300), 97);
    assert.equal(pct(1, 3), 33.33);
  });

  test('mẫu số 0 → null, không phải Infinity', () => {
    assert.equal(pct(10, 0), null);
  });

  test('thiếu số → null', () => {
    assert.equal(pct(null, 300), null);
    assert.equal(pct(10, null), null);
  });
});

describe('toSummaryRow', () => {
  test('gap = fc − actual, dương nghĩa là dự báo cao hơn thực bán', () => {
    const row = toSummaryRow(agg({ fcQty: 300.7, actualQty: 250 }));
    assert.equal(row.gapQty, 50.7);
    assert.equal(row.gapPct, 20.28);
  });

  test('actual null (tháng chưa có TT) → gap null, KHÔNG coi là 0', () => {
    const row = toSummaryRow(agg({ fcQty: 300.7, actualQty: null }));
    assert.equal(row.actualQty, null);
    assert.equal(row.gapQty, null);
    assert.equal(row.gapPct, null);
  });

  test('actual = 0 thật sự → gap tính được, gapPct null vì chia 0', () => {
    const row = toSummaryRow(agg({ fcQty: 100, actualQty: 0 }));
    assert.equal(row.gapQty, 100);
    assert.equal(row.gapPct, null);
  });

  test('WMAPE dùng mẫu số riêng, không dùng actualQty tổng', () => {
    // Tổng actual là 1000 nhưng chỉ 400 nằm trên dòng có đủ cả fc lẫn actual.
    // Lấy mẫu số 1000 sẽ ra 10% — sai số nhìn nhỏ đi một cách giả tạo.
    const row = toSummaryRow(agg({
      fcQty: 500, actualQty: 1000,
      fcAbsErr: 100, actualComparable: 400,
    }));
    assert.equal(row.fcWmapePct, 25);
  });

  test('MA3 và FC có mẫu số riêng — dòng thiếu ma3 không kéo mẫu số của FC', () => {
    const row = toSummaryRow(agg({
      fcAbsErr: 100, actualComparable: 400,
      ma3AbsErr: 90, actualComparableMa3: 300,
    }));
    assert.equal(row.fcWmapePct, 25);
    assert.equal(row.ma3WmapePct, 30);
  });

  test('làm tròn 2 chữ số khớp numeric(15,2) của cột nguồn', () => {
    const row = toSummaryRow(agg({ fcQty: 453275.4567, ma3Qty: 529381.129 }));
    assert.equal(row.fcQty, 453275.46);
    assert.equal(row.ma3Qty, 529381.13);
  });

  test('giữ nguyên khoá nhóm và các bộ đếm', () => {
    const row = toSummaryRow(agg({
      cnCode: '049', cnName: 'CN Hà Nội', region: 'Bắc', month: '2026-09',
      rowCount: 42, skuCount: 40, cnCount: 1, ma3RowCount: 38, comparableRowCount: 30,
    }));
    assert.equal(row.cnCode, '049');
    assert.equal(row.cnName, 'CN Hà Nội');
    assert.equal(row.month, '2026-09');
    assert.equal(row.rowCount, 42);
    assert.equal(row.ma3RowCount, 38);
    assert.equal(row.comparableRowCount, 30);
  });
});

describe('parseGroupBy', () => {
  test('thiếu → cn (mặc định)', () => {
    assert.equal(parseGroupBy(undefined), 'cn');
    assert.equal(parseGroupBy(''), 'cn');
  });

  test('4 giá trị hợp lệ', () => {
    for (const v of ['cn', 'month', 'cn-month', 'none'] as const) {
      assert.equal(parseGroupBy(v), v);
    }
  });

  test('giá trị lạ → lỗi, KHÔNG lặng lẽ về mặc định', () => {
    assert.throws(() => parseGroupBy('sku'), BadQueryError);
  });
});

describe('parseCsvList', () => {
  test('cắt khoảng trắng, bỏ phần rỗng', () => {
    assert.deepEqual(parseCsvList('049, 050 ,,051'), ['049', '050', '051']);
  });

  test('rỗng → undefined (không lọc), không phải mảng rỗng (lọc hết)', () => {
    assert.equal(parseCsvList(undefined), undefined);
    assert.equal(parseCsvList(''), undefined);
    assert.equal(parseCsvList(' , '), undefined);
  });
});

describe('parseBool', () => {
  test('chỉ chuỗi phủ định rõ ràng mới tắt', () => {
    assert.equal(parseBool('0', true), false);
    assert.equal(parseBool('false', true), false);
  });

  test('thiếu hoặc lạ → giữ mặc định', () => {
    assert.equal(parseBool(undefined, true), true);
    assert.equal(parseBool('xyz', true), true);
    assert.equal(parseBool('xyz', false), false);
  });
});

describe('parseSummaryQuery', () => {
  const at = new Date(Date.UTC(2026, 7, 26)); // 2026-08-26

  test('không tham số → tháng hiện tại, groupBy cn, ẩn SKU Ngừng', () => {
    const q = parseSummaryQuery(new URLSearchParams(), at);
    assert.equal(q.from, '2026-08');
    assert.equal(q.to, '2026-08');
    assert.equal(q.groupBy, 'cn');
    assert.equal(q.hideInactiveSku, true);
    assert.equal(q.rounded, false);
  });

  test('chỉ có from → to lấy bằng from (một tháng)', () => {
    const q = parseSummaryQuery(new URLSearchParams('from=2026-09'), at);
    assert.equal(q.from, '2026-09');
    assert.equal(q.to, '2026-09');
  });

  test('tháng sai định dạng → lỗi', () => {
    assert.throws(() => parseSummaryQuery(new URLSearchParams('from=2026-9'), at), BadQueryError);
    assert.throws(() => parseSummaryQuery(new URLSearchParams('from=2026-13'), at), BadQueryError);
    assert.throws(() => parseSummaryQuery(new URLSearchParams('from=08-2026'), at), BadQueryError);
  });

  test('to < from → lỗi thay vì trả rỗng không rõ vì sao', () => {
    assert.throws(
      () => parseSummaryQuery(new URLSearchParams('from=2026-09&to=2026-08'), at),
      BadQueryError,
    );
  });

  test('to = from là hợp lệ (đúng một tháng)', () => {
    const q = parseSummaryQuery(new URLSearchParams('from=2026-08&to=2026-08'), at);
    assert.equal(q.from, q.to);
  });

  test('lọc CN và SKU nhận danh sách ngăn bằng phẩy', () => {
    const q = parseSummaryQuery(new URLSearchParams('cnCode=049,050&skuCode=X'), at);
    assert.deepEqual(q.cnCodes, ['049', '050']);
    assert.deepEqual(q.skuCodes, ['X']);
  });

  test('hideInactiveSku=0 và rounded=true', () => {
    const q = parseSummaryQuery(new URLSearchParams('hideInactiveSku=0&rounded=true'), at);
    assert.equal(q.hideInactiveSku, false);
    assert.equal(q.rounded, true);
  });
});

describe('currentMonth', () => {
  test('đệm 0 cho tháng một chữ số', () => {
    assert.equal(currentMonth(new Date(2026, 0, 15)), '2026-01');
    assert.equal(currentMonth(new Date(2026, 11, 1)), '2026-12');
  });
});

describe('SummaryService', () => {
  /** Reader giả — ghi lại mọi lượt gọi để kiểm chứng service gọi đúng mấy lượt. */
  function fakeReader(byGroup: Record<string, SummaryAggregate[]>) {
    const calls: string[] = [];
    const reader: SummaryReader = {
      async aggregate(_q, groupBy) {
        calls.push(groupBy);
        return byGroup[groupBy] ?? [];
      },
    };
    return { reader, calls };
  }

  const query: SummaryQuery = {
    from: '2026-09', to: '2026-09', groupBy: 'cn',
    hideInactiveSku: true, rounded: false,
  };

  test('gọi reader 2 lượt: nhóm + dòng tổng', async () => {
    const { reader, calls } = fakeReader({
      cn: [agg({ cnCode: '049', fcQty: 100 })],
      none: [agg({ fcQty: 100, skuCount: 3, cnCount: 1 })],
    });
    const result = await new SummaryService(reader).summarize(query);

    assert.deepEqual(calls.sort(), ['cn', 'none']);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].cnCode, '049');
    assert.equal(result.total.skuCount, 3);
  });

  test("groupBy='none' chỉ gọi 1 lượt, rows rỗng", async () => {
    const { reader, calls } = fakeReader({ none: [agg({ fcQty: 100 })] });
    const result = await new SummaryService(reader).summarize({ ...query, groupBy: 'none' });

    assert.deepEqual(calls, ['none']);
    assert.deepEqual(result.rows, []);
    assert.equal(result.total.fcQty, 100);
  });

  test('không dòng nào khớp → total là khung rỗng, không phải undefined', async () => {
    const { reader } = fakeReader({});
    const result = await new SummaryService(reader).summarize(query);

    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.total, emptySummaryRow());
  });

  test('total KHÔNG phải tổng của rows — đếm phân biệt không cộng dồn được', async () => {
    // Cùng 1 SKU bán ở 2 CN: cộng skuCount của 2 dòng ra 2, số đúng là 1.
    const { reader } = fakeReader({
      cn: [
        agg({ cnCode: '049', fcQty: 60, skuCount: 1, cnCount: 1 }),
        agg({ cnCode: '050', fcQty: 40, skuCount: 1, cnCount: 1 }),
      ],
      none: [agg({ fcQty: 100, skuCount: 1, cnCount: 2 })],
    });
    const result = await new SummaryService(reader).summarize(query);

    assert.equal(result.rows[0].skuCount + result.rows[1].skuCount, 2);
    assert.equal(result.total.skuCount, 1);
    assert.equal(result.total.cnCount, 2);
  });

  test('trả lại nguyên bộ lọc để phía gọi biết số này của khoảng nào', async () => {
    const { reader } = fakeReader({ none: [agg()] });
    const result = await new SummaryService(reader).summarize({
      ...query, from: '2026-01', to: '2026-12', rounded: true,
    });

    assert.equal(result.from, '2026-01');
    assert.equal(result.to, '2026-12');
    assert.equal(result.rounded, true);
    assert.equal(result.groupBy, 'cn');
  });
});
