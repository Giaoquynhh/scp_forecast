import type pg from 'pg';
import type { ActualLine, PairBlockTotals, SalesReader } from '../domain/types.js';

/**
 * Đọc dữ liệu bán từ f2_supply.sales_transaction_v2.
 *
 * Repository chỉ làm một việc: gom số. Mọi công thức nằm ở domain/forecast-formula.
 * Class ở đây là xứng đáng vì nó giữ connection pool — không phải class cho có.
 *
 * Bộ lọc giữ nguyên quy tắc đã chốt với nghiệp vụ bên SCP
 * (SmartlogSCP.Backend/src/demand/tt-recompute.service.ts):
 *   - map item_code = sku.bravo_sku → gộp theo sku.sku_code (SKU gốc master data)
 *   - chỉ đơn vị m2, bỏ Kg và đơn vị khác
 *   - chỉ cộng lượng BÁN RA (quantity > 0) — dòng trả hàng mang số âm bị loại hẳn
 *   - cn_code phải có trong channel
 */
export class SalesRepository implements SalesReader {
  /** Điều kiện lọc dùng chung cho mọi truy vấn của repository này. */
  private static readonly FILTER = `lower(st.unit) = 'm2' AND st.quantity > 0`;

  constructor(private readonly pool: pg.Pool) {}

  async blockTotals(
    ranges: Array<{ from: string; to: string }>,
  ): Promise<PairBlockTotals[]> {
    if (ranges.length !== 3) {
      throw new RangeError(`Cần đúng 3 khối, nhận được ${ranges.length}`);
    }
    const [r1, r2, r3] = ranges;

    const { rows } = await this.pool.query<{
      cn_code: string; sku_code: string; b1: number; b2: number; b3: number;
    }>(
      `
      SELECT st.branch_code_0 AS cn_code,
             s.sku_code,
             COALESCE(sum(st.quantity) FILTER (WHERE st.doc_date >= $1::date AND st.doc_date < $2::date), 0) AS b1,
             COALESCE(sum(st.quantity) FILTER (WHERE st.doc_date >= $3::date AND st.doc_date < $4::date), 0) AS b2,
             COALESCE(sum(st.quantity) FILTER (WHERE st.doc_date >= $5::date AND st.doc_date < $6::date), 0) AS b3
        FROM f2_supply.sales_transaction_v2 st
        JOIN public.sku s     ON st.item_code = s.bravo_sku
        JOIN public.channel c ON c.cn_code = st.branch_code_0
       WHERE ${SalesRepository.FILTER}
         AND st.doc_date >= $5::date
         AND st.doc_date <  $2::date
       GROUP BY 1, 2
       ORDER BY 1, 2
      `,
      [r1.from, r1.to, r2.from, r2.to, r3.from, r3.to],
    );

    return rows.map((r) => ({
      cnCode: r.cn_code,
      skuCode: r.sku_code,
      b1: r.b1,
      b2: r.b2,
      b3: r.b3,
    }));
  }

  /**
   * Tháng hiện tại chỉ cộng tới hôm nay (doc_date <= CURRENT_DATE); tháng quá khứ
   * cộng trọn tháng.
   */
  async monthlyActuals(fromMonth: string, toMonth: string): Promise<ActualLine[]> {
    const { rows } = await this.pool.query<{
      cn_code: string; sku_code: string; period_start: string; actual_qty: number;
    }>(
      `
      SELECT st.branch_code_0 AS cn_code,
             s.sku_code,
             TO_CHAR(date_trunc('month', st.doc_date), 'YYYY-MM-DD') AS period_start,
             round(sum(st.quantity), 2) AS actual_qty
        FROM f2_supply.sales_transaction_v2 st
        JOIN public.sku s     ON st.item_code = s.bravo_sku
        JOIN public.channel c ON c.cn_code = st.branch_code_0
       WHERE ${SalesRepository.FILTER}
         AND st.doc_date >= $1::date
         AND st.doc_date <  ($2::date + INTERVAL '1 month')
         AND st.doc_date <= CURRENT_DATE
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3
      `,
      [fromMonth, toMonth],
    );

    return rows.map((r) => ({
      cnCode: r.cn_code,
      skuCode: r.sku_code,
      periodStart: r.period_start,
      actualQty: r.actual_qty,
    }));
  }

  async latestSalesDate(since: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ d: string | null }>(
      `SELECT TO_CHAR(max(doc_date), 'YYYY-MM-DD') AS d
         FROM f2_supply.sales_transaction_v2
        WHERE doc_date >= $1::date`,
      [since],
    );
    return rows[0]?.d ?? null;
  }
}
