import type pg from 'pg';
import type {
  GroupBy, SummaryAggregate, SummaryQuery, SummaryReader,
} from '../domain/summary.js';

/**
 * Gom tổng FC / MA3 / TT từ branch_forecast.
 *
 * Repository chỉ cộng số; mọi phép chia và làm tròn nằm ở domain/summary. Class ở
 * đây xứng đáng vì nó giữ connection pool — cùng lý do như SalesRepository.
 *
 * Đẩy phép cộng xuống Postgres thay vì trả từng ô rồi cộng ở client: bảng có
 * ~90 nghìn dòng, một tháng của một CN đã là vài trăm ô. Bên SCP endpoint
 * `grid/cn` trả cả ~12 MB rồi để FE tự cộng — đó chính là lý do màn F1-B1 bị
 * tạm dừng vì timeout.
 */
export class SummaryRepository implements SummaryReader {
  constructor(private readonly pool: pg.Pool) {}

  async aggregate(query: SummaryQuery, groupBy: GroupBy): Promise<SummaryAggregate[]> {
    const fc = query.rounded ? 'bf.fc_qty_rounded' : 'bf.fc_qty';
    const actual = query.rounded ? 'bf.actual_qty_rounded' : 'bf.actual_qty';

    // $1/$2 là khoảng tháng; filter tùy chọn nối thêm theo đúng thứ tự đẩy vào values.
    const values: unknown[] = [query.from, query.to];
    const where = [`TO_CHAR(bf.period_start, 'YYYY-MM') BETWEEN $1 AND $2`];

    if (query.cnCodes) {
      values.push(query.cnCodes);
      where.push(`bf.cn_code = ANY($${values.length}::text[])`);
    }
    if (query.skuCodes) {
      values.push(query.skuCodes);
      where.push(`bf.sku_code = ANY($${values.length}::text[])`);
    }
    // IS NOT FALSE giữ lại SKU thiếu master-data (active NULL) — bỏ chúng đi thì
    // tổng ở đây sẽ lệch so với tổng người dùng thấy trên grid bên SCP.
    if (query.hideInactiveSku) {
      where.push(`bf.sku_code IN (SELECT sku_code FROM sku WHERE active IS NOT FALSE)`);
    }

    const byCn = groupBy === 'cn' || groupBy === 'cn-month';
    const byMonth = groupBy === 'month' || groupBy === 'cn-month';
    const keys: string[] = [];
    if (byCn) keys.push('bf.cn_code');
    if (byMonth) keys.push(`TO_CHAR(bf.period_start, 'YYYY-MM')`);

    // Chỉ dòng có ĐỦ hai số mới vào WMAPE. Tháng chưa có TT mà tính vào sẽ kéo
    // mẫu số xuống và làm sai số nhìn nhỏ đi.
    const cmpFc = `${fc} IS NOT NULL AND ${actual} IS NOT NULL`;
    const cmpMa3 = `bf.ma3 IS NOT NULL AND ${actual} IS NOT NULL`;

    const { rows } = await this.pool.query<RawRow>(
      `
      SELECT ${byCn
        ? `bf.cn_code AS cn_code,
             MAX(c.cn_name) AS cn_name,
             MAX(COALESCE(c.region, '—')) AS region`
        : `NULL::text AS cn_code, NULL::text AS cn_name, NULL::text AS region`},
             ${byMonth
        ? `TO_CHAR(bf.period_start, 'YYYY-MM') AS month`
        : `NULL::text AS month`},
             SUM(${fc})::float8                                        AS fc_qty,
             SUM(bf.ma3)::float8                                       AS ma3_qty,
             SUM(${actual})::float8                                    AS actual_qty,
             SUM(ABS(${fc} - ${actual})) FILTER (WHERE ${cmpFc})::float8   AS fc_abs_err,
             SUM(${actual})              FILTER (WHERE ${cmpFc})::float8   AS actual_comparable,
             SUM(ABS(bf.ma3 - ${actual})) FILTER (WHERE ${cmpMa3})::float8 AS ma3_abs_err,
             SUM(${actual})              FILTER (WHERE ${cmpMa3})::float8  AS actual_comparable_ma3,
             COUNT(*)::int                                             AS row_count,
             COUNT(DISTINCT bf.sku_code)::int                          AS sku_count,
             COUNT(DISTINCT bf.cn_code)::int                           AS cn_count,
             COUNT(bf.ma3)::int                                        AS ma3_row_count,
             COUNT(*) FILTER (WHERE ${cmpFc})::int                     AS comparable_row_count
        FROM branch_forecast bf
        ${byCn ? 'LEFT JOIN channel c ON c.cn_code = bf.cn_code' : ''}
       WHERE ${where.join('\n         AND ')}
       ${keys.length > 0 ? `GROUP BY ${keys.join(', ')}` : ''}
       ${keys.length > 0 ? `ORDER BY ${keys.join(', ')}` : ''}
      `,
      values,
    );

    return rows.map(toAggregate);
  }
}

interface RawRow {
  cn_code: string | null;
  cn_name: string | null;
  region: string | null;
  month: string | null;
  fc_qty: number | null;
  ma3_qty: number | null;
  actual_qty: number | null;
  fc_abs_err: number | null;
  actual_comparable: number | null;
  ma3_abs_err: number | null;
  actual_comparable_ma3: number | null;
  row_count: number;
  sku_count: number;
  cn_count: number;
  ma3_row_count: number;
  comparable_row_count: number;
}

function toAggregate(r: RawRow): SummaryAggregate {
  return {
    cnCode: r.cn_code,
    cnName: r.cn_name,
    region: r.region,
    month: r.month,
    fcQty: r.fc_qty,
    ma3Qty: r.ma3_qty,
    actualQty: r.actual_qty,
    fcAbsErr: r.fc_abs_err,
    actualComparable: r.actual_comparable,
    ma3AbsErr: r.ma3_abs_err,
    actualComparableMa3: r.actual_comparable_ma3,
    rowCount: Number(r.row_count),
    skuCount: Number(r.sku_count),
    cnCount: Number(r.cn_count),
    ma3RowCount: Number(r.ma3_row_count),
    comparableRowCount: Number(r.comparable_row_count),
  };
}
