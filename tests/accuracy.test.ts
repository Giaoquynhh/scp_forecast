import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isClosedMonth, needsRefresh, refreshWindow, wape, type MonthState,
} from '../src/domain/accuracy.js';

/** 02:00 giờ địa phương — cùng cách schedule.test.ts dựng ngày. */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 2, 0, 0);

describe('wape — khớp flWape() bên SCP', () => {
  test('bình thường', () => assert.equal(wape(20, 100), 80));
  test('kẹp sàn 0', () => assert.equal(wape(250, 100), 0));
  test('tt = 0, không lệch → 100', () => assert.equal(wape(0, 0), 100));
  test('tt = 0, có lệch → 0', () => assert.equal(wape(5, 0), 0));
  test('thiếu số → null', () => {
    assert.equal(wape(null, 100), null);
    assert.equal(wape(1, null), null);
  });
});

describe('isClosedMonth', () => {
  test('30/09: tháng 8 khép, tháng 9 và 10 chưa', () => {
    const now = at(2026, 9, 30);
    assert.equal(isClosedMonth('2026-08-01', now), true);
    assert.equal(isClosedMonth('2026-09-01', now), false);
    assert.equal(isClosedMonth('2026-10-01', now), false);
  });
  test('01/10: tháng 9 vừa khép', () => {
    assert.equal(isClosedMonth('2026-09-01', at(2026, 10, 1)), true);
  });
});

describe('refreshWindow', () => {
  test('13 tháng lùi + tháng sau, qua ranh năm', () => {
    const w = refreshWindow(at(2026, 9, 30));
    assert.equal(w.length, 14);
    assert.equal(w[0], '2025-09-01');
    assert.equal(w[12], '2026-09-01');
    assert.equal(w[13], '2026-10-01');
  });
});

describe('needsRefresh', () => {
  const base: MonthState = {
    period: '2026-08-01', sourceRows: 10, sourceUpdatedAt: new Date('2026-09-01T00:00:00Z'),
    accRows: 10, accComputedAt: new Date('2026-09-02T00:00:00Z'), accClosed: true,
  };
  const now = at(2026, 9, 30);

  test('đã tính sau lần ghi nguồn cuối → không', () => assert.equal(needsRefresh(base, now), false));
  test('nguồn ghi sau lần tính → có', () => {
    assert.equal(needsRefresh({ ...base, sourceUpdatedAt: new Date('2026-09-03T00:00:00Z') }, now), true);
  });
  test('lệch số dòng → có', () => assert.equal(needsRefresh({ ...base, accRows: 9 }, now), true));
  test('chưa có dòng accuracy → có', () => {
    assert.equal(needsRefresh({ ...base, accRows: 0, accComputedAt: null, accClosed: null }, now), true);
  });
  test('mùng 1: tháng trước vừa khép, cờ closed cũ = false → có', () => {
    const sep: MonthState = { ...base, period: '2026-09-01', accClosed: false };
    assert.equal(needsRefresh(sep, at(2026, 9, 30)), false);
    assert.equal(needsRefresh(sep, at(2026, 10, 1)), true);
  });
  test('tháng rỗng cả hai phía → không', () => {
    assert.equal(needsRefresh({ ...base, sourceRows: 0, accRows: 0 }, now), false);
  });
});
