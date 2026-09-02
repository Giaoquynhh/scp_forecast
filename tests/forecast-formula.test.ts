import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  forecastQty, hasDemand, movingAverage3, perDay, round2, weightedDemand,
  type Weights,
} from '../src/domain/forecast-formula.js';

const W: Weights = [0.6, 0.3, 0.1];

describe('công thức FC', () => {
  it('khớp ví dụ nghiệp vụ: B1=310, B2=300, B3=150, tháng 8 (31 ngày)', () => {
    const blocks = { b1: 310, b2: 300, b3: 150 };
    assert.equal(round2(weightedDemand(blocks, W)), 291);
    assert.equal(round2(perDay(291, 30)), 9.7);
    assert.equal(forecastQty(blocks, W, 30, 31), 300.7);
  });

  it('ưu tiên tháng gần: cùng tổng nhưng dồn vào B1 thì FC cao hơn', () => {
    const dồnGần = { b1: 300, b2: 0, b3: 0 };
    const dồnXa = { b1: 0, b2: 0, b3: 300 };
    assert.ok(forecastQty(dồnGần, W, 30, 30) > forecastQty(dồnXa, W, 30, 30));
  });

  it('mẫu số luôn là 30 dù tháng đích 28 hay 31 ngày', () => {
    const blocks = { b1: 300, b2: 300, b3: 300 };
    // weighted = 300, perDay = 10 → FC = 10 × số ngày tháng đích
    assert.equal(forecastQty(blocks, W, 30, 28), 280);
    assert.equal(forecastQty(blocks, W, 30, 31), 310);
  });

  it('không bán gì thì FC = 0', () => {
    assert.equal(forecastQty({ b1: 0, b2: 0, b3: 0 }, W, 30, 31), 0);
  });

  it('từ chối tham số vô lý thay vì trả số rác', () => {
    assert.throws(() => perDay(100, 0), RangeError);
    assert.throws(() => forecastQty({ b1: 1, b2: 1, b3: 1 }, W, 30, 0), RangeError);
  });

  it('làm tròn 2 chữ số, không để lỗi dấu phẩy động lọt ra', () => {
    // 0.6·310 trong dấu phẩy động là 186.00000000000003
    assert.equal(forecastQty({ b1: 310, b2: 300, b3: 150 }, W, 30, 31), 300.7);
    assert.equal(round2(0.1 + 0.2), 0.3);
  });
});

describe('MA3', () => {
  it('là trung bình cộng, quy về tháng đích như FC', () => {
    const blocks = { b1: 310, b2: 300, b3: 150 };
    // (310+300+150)/3 = 253.33 → /30 = 8.44/ngày → ×30 ngày = 253.33
    assert.equal(movingAverage3(blocks, 30, 30), 253.33);
    // tháng 31 ngày thì nhiều hơn đúng 1 ngày bán — chỗ mà bản cũ bỏ qua
    assert.equal(movingAverage3(blocks, 30, 31), 261.78);
  });

  it('cao hơn FC khi tháng xa bán nhiều hơn tháng gần', () => {
    const blocks = { b1: 100, b2: 300, b3: 500 };
    assert.ok(movingAverage3(blocks, 30, 30) > forecastQty(blocks, W, 30, 30));
  });

  it('đúng bằng FC khi trọng số đều — khác nhau CHỈ còn ở trọng số', () => {
    const blocks = { b1: 90, b2: 60, b3: 30 };
    const đều: Weights = [1 / 3, 1 / 3, 1 / 3];
    assert.equal(movingAverage3(blocks, 30, 31), forecastQty(blocks, đều, 30, 31));
  });

  it('co giãn theo số ngày tháng đích y như FC (28 vs 31)', () => {
    const blocks = { b1: 300, b2: 300, b3: 300 };
    assert.equal(movingAverage3(blocks, 30, 28), 280);
    assert.equal(movingAverage3(blocks, 30, 31), 310);
  });

  it('không bán gì thì MA3 = 0', () => {
    assert.equal(movingAverage3({ b1: 0, b2: 0, b3: 0 }, 30, 31), 0);
  });
});

describe('hasDemand', () => {
  it('bỏ cặp không bán gì trong cả 3 khối', () => {
    assert.equal(hasDemand({ b1: 0, b2: 0, b3: 0 }), false);
    assert.equal(hasDemand({ b1: 0, b2: 0, b3: 0.5 }), true);
  });
});
