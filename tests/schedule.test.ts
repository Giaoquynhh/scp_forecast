import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysBetween, daysInMonthOf, describeFcDaySpec, fcTargetMonth, isFcRunDay,
  missingDaysInBlock, parseFcDaySpec, resolveTarget, toDateOnly,
} from '../src/domain/period.js';
import { planRun } from '../src/app/scheduler.js';
import type { CliArgs } from '../src/app/cli.js';

/** Ngày giờ địa phương — planRun/isFcRunDay đọc getDate() theo giờ máy chủ. */
function at(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 2, 0, 0);
}

describe('parseFcDaySpec', () => {
  test("'last' → ngày cuối tháng", () => {
    assert.deepEqual(parseFcDaySpec('last'), { kind: 'fromEnd', offset: 0 });
  });

  test("'last-2' → trước ngày cuối 2 ngày", () => {
    assert.deepEqual(parseFcDaySpec('last-2'), { kind: 'fromEnd', offset: 2 });
  });

  test('số → ngày cố định', () => {
    assert.deepEqual(parseFcDaySpec('1'), { kind: 'day', day: 1 });
    assert.deepEqual(parseFcDaySpec('15'), { kind: 'day', day: 15 });
  });

  test('offset quá lớn → lỗi (tháng 2 chỉ 28 ngày)', () => {
    assert.throws(() => parseFcDaySpec('last-28'), /27/);
  });

  test('giá trị lạ → lỗi', () => {
    assert.throws(() => parseFcDaySpec('0'));
    assert.throws(() => parseFcDaySpec('32'));
    assert.throws(() => parseFcDaySpec('cuoi-thang'));
  });
});

describe('daysInMonthOf', () => {
  test('tháng 31 / 30 / 28 / 29 ngày', () => {
    assert.equal(daysInMonthOf(2026, 7), 31); // tháng 8
    assert.equal(daysInMonthOf(2026, 8), 30); // tháng 9
    assert.equal(daysInMonthOf(2026, 1), 28); // tháng 2/2026
    assert.equal(daysInMonthOf(2028, 1), 29); // tháng 2/2028 nhuận
  });
});

describe('isFcRunDay', () => {
  const last = parseFcDaySpec('last');

  test("'last' khớp ngày cuối của tháng dài khác nhau", () => {
    assert.equal(isFcRunDay(at(2026, 8, 31), last), true);  // tháng 8: 31 ngày
    assert.equal(isFcRunDay(at(2026, 9, 30), last), true);  // tháng 9: 30 ngày
    assert.equal(isFcRunDay(at(2026, 2, 28), last), true);  // tháng 2/2026: 28 ngày
    assert.equal(isFcRunDay(at(2028, 2, 29), last), true);  // tháng 2 nhuận
  });

  test("'last' KHÔNG khớp ngày áp cuối", () => {
    assert.equal(isFcRunDay(at(2026, 8, 30), last), false);
    assert.equal(isFcRunDay(at(2026, 9, 29), last), false);
  });

  test("'last-1' khớp ngày áp cuối", () => {
    const spec = parseFcDaySpec('last-1');
    assert.equal(isFcRunDay(at(2026, 8, 30), spec), true);
    assert.equal(isFcRunDay(at(2026, 8, 31), spec), false);
    assert.equal(isFcRunDay(at(2026, 2, 27), spec), true);
  });

  test('ngày cố định lớn hơn số ngày của tháng thì kẹp về ngày cuối', () => {
    // Không kẹp thì FC_DAY_OF_MONTH=31 sẽ không bao giờ chạy vào tháng 2, 4, 6…
    const spec = parseFcDaySpec('31');
    assert.equal(isFcRunDay(at(2026, 2, 28), spec), true);
    assert.equal(isFcRunDay(at(2026, 9, 30), spec), true);
    assert.equal(isFcRunDay(at(2026, 8, 31), spec), true);
    assert.equal(isFcRunDay(at(2026, 8, 30), spec), false);
  });

  test('mùng 1', () => {
    const spec = parseFcDaySpec('1');
    assert.equal(isFcRunDay(at(2026, 9, 1), spec), true);
    assert.equal(isFcRunDay(at(2026, 9, 2), spec), false);
  });
});

describe('describeFcDaySpec', () => {
  test('mô tả đọc được cho log', () => {
    assert.equal(describeFcDaySpec(parseFcDaySpec('last')), 'ngày cuối tháng');
    assert.equal(describeFcDaySpec(parseFcDaySpec('last-3')), 'trước ngày cuối tháng 3 ngày');
    assert.equal(describeFcDaySpec(parseFcDaySpec('1')), 'ngày 1 hằng tháng');
  });
});

describe('fcTargetMonth', () => {
  test("'next' → tháng sau, luôn về ngày 1", () => {
    assert.equal(toDateOnly(fcTargetMonth(at(2026, 8, 31), 'next')), '2026-09-01');
    assert.equal(toDateOnly(fcTargetMonth(at(2026, 8, 15), 'next')), '2026-09-01');
  });

  test("'next' vắt qua năm", () => {
    assert.equal(toDateOnly(fcTargetMonth(at(2026, 12, 31), 'next')), '2027-01-01');
  });

  test("'current' → tháng đang chạy", () => {
    assert.equal(toDateOnly(fcTargetMonth(at(2026, 9, 1), 'current')), '2026-09-01');
  });
});

describe('resolveTarget', () => {
  test('--month tường minh thì mode không ảnh hưởng', () => {
    assert.equal(toDateOnly(resolveTarget('2026-06', 'next')), '2026-06-01');
    assert.equal(toDateOnly(resolveTarget('2026-06', 'current')), '2026-06-01');
  });

  test('mặc định mode current — giữ nguyên hành vi của bản cũ', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    assert.equal(toDateOnly(resolveTarget()), expected);
  });
});

describe('daysBetween', () => {
  test('đầu bao gồm, cuối không', () => {
    assert.equal(daysBetween('2026-08-01', '2026-09-01'), 31);
    assert.equal(daysBetween('2026-09-01', '2026-10-01'), 30);
    assert.equal(daysBetween('2026-08-01', '2026-08-01'), 0);
  });

  test('vắt qua năm', () => {
    assert.equal(daysBetween('2026-12-01', '2027-01-01'), 31);
  });
});

describe('missingDaysInBlock', () => {
  const b1 = { from: '2026-08-01', to: '2026-09-01' }; // tháng 8, 31 ngày

  test('khối đã đóng sổ → không thiếu ngày nào', () => {
    assert.equal(missingDaysInBlock(b1, '2026-09-15'), 0);
    assert.equal(missingDaysInBlock(b1, '2026-08-31'), 0);
  });

  test('chạy 02:00 ngày 31/08, dữ liệu tới 30/08 → thiếu 1 ngày', () => {
    assert.equal(missingDaysInBlock(b1, '2026-08-30'), 1);
  });

  test('dữ liệu về trễ 2 ngày → thiếu 2 ngày', () => {
    assert.equal(missingDaysInBlock(b1, '2026-08-29'), 2);
  });

  test('chưa có dữ liệu nào trong khối → thiếu cả khối', () => {
    assert.equal(missingDaysInBlock(b1, '2026-07-20'), 31);
    assert.equal(missingDaysInBlock(b1, null), 31);
  });
});

describe('planRun', () => {
  /** Cấu hình mặc định mới: cuối tháng, nhắm tháng sau, có lượt chốt mùng 1. */
  const cfg = {
    fcDay: parseFcDaySpec('last'),
    fcTarget: 'next' as const,
    fcFinalizeOnFirst: true,
    fcRecomputeDaily: false,
    ttMonths: 1,
    ttCloseoutPrevMonth: true,
  };

  test('cuối tháng 8 → FC tháng 9, TT vẫn tháng 8', () => {
    const p = planRun(at(2026, 8, 31), cfg);
    assert.equal(p.doFc, true);
    assert.equal(p.finalize, false);
    assert.equal(toDateOnly(p.fcTarget), '2026-09-01');
    assert.equal(toDateOnly(p.ttTarget), '2026-08-01');
  });

  test('mùng 1/9 → lượt chốt, FC lại tháng 9 (KHÔNG nhảy sang tháng 10)', () => {
    const p = planRun(at(2026, 9, 1), cfg);
    assert.equal(p.doFc, true);
    assert.equal(p.finalize, true);
    assert.equal(toDateOnly(p.fcTarget), '2026-09-01');
    assert.equal(toDateOnly(p.ttTarget), '2026-09-01');
  });

  test('mùng 1 mở rộng phạm vi TT để chốt sổ tháng trước', () => {
    assert.equal(planRun(at(2026, 9, 1), cfg).ttMonths, 2);
    assert.equal(planRun(at(2026, 9, 15), cfg).ttMonths, 1);
  });

  test('ngày thường giữa tháng → chỉ TT', () => {
    const p = planRun(at(2026, 8, 15), cfg);
    assert.equal(p.doFc, false);
    assert.equal(toDateOnly(p.ttTarget), '2026-08-01');
  });

  test('cuối tháng 12 → FC tháng 1 năm sau', () => {
    assert.equal(toDateOnly(planRun(at(2026, 12, 31), cfg).fcTarget), '2027-01-01');
  });

  test('cuối tháng 2/2026 (28 ngày) vẫn nổ', () => {
    const p = planRun(at(2026, 2, 28), cfg);
    assert.equal(p.doFc, true);
    assert.equal(toDateOnly(p.fcTarget), '2026-03-01');
  });

  test('FC_FINALIZE_ON_FIRST=false → mùng 1 chỉ chạy TT', () => {
    const p = planRun(at(2026, 9, 1), { ...cfg, fcFinalizeOnFirst: false });
    assert.equal(p.doFc, false);
    assert.equal(p.finalize, false);
    // Chốt sổ TT vẫn giữ — nó gắn với mùng 1, không gắn với ngày sinh FC.
    assert.equal(p.ttMonths, 2);
  });

  test('cách cũ (mùng 1 + current) vẫn ra đúng như trước', () => {
    const old = { ...cfg, fcDay: parseFcDaySpec('1'), fcTarget: 'current' as const };
    const p = planRun(at(2026, 9, 1), old);
    assert.equal(p.doFc, true);
    // Mùng 1 vừa là ngày sinh FC nên không phải "lượt chốt" thêm.
    assert.equal(p.finalize, false);
    assert.equal(toDateOnly(p.fcTarget), '2026-09-01');
    assert.equal(p.ttMonths, 2);
  });

  test('cách cũ: cuối tháng không sinh FC', () => {
    const old = { ...cfg, fcDay: parseFcDaySpec('1'), fcTarget: 'current' as const };
    assert.equal(planRun(at(2026, 8, 31), old).doFc, false);
  });

  test('fcRecomputeDaily → lượt nào cũng có FC', () => {
    const p = planRun(at(2026, 8, 15), { ...cfg, fcRecomputeDaily: true });
    assert.equal(p.doFc, true);
    assert.equal(toDateOnly(p.fcTarget), '2026-09-01');
  });
});

describe('cli --serve / --port', () => {
  test('kiểu CliArgs có serve và port', () => {
    // Chốt hình dạng kiểu để đổi tên trường là vỡ test, không vỡ âm thầm.
    const a: Pick<CliArgs, 'serve' | 'port'> = { serve: true, port: 3010 };
    assert.equal(a.serve, true);
    assert.equal(a.port, 3010);
  });
});
