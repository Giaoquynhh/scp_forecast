import type { Pool } from 'pg';
import type { MonthState } from '../domain/accuracy.js';

/**
 * Ghi forecast_accuracy_sku / forecast_accuracy_cn từ branch_forecast.
 *
 * Tính HOÀN TOÀN trong SQL: đọc hàng chục nghìn dòng lên Node rồi ghi ngược xuống là
 * phí, còn phép tính chỉ là cộng + chia. Mỗi tháng một transaction, xoá rồi dựng lại
 * — bảng này là dữ liệu dẫn xuất, không có gì để giữ.
 */

/** Ô được chấm — PHẢI khớp hằng SCORED ở forecast-learning.service.ts bên SCP. */
const SCORED = 'actual_qty IS NOT NULL AND fc_qty IS NOT NULL AND ma3 IS NOT NULL';

/** flWape() bản SQL — xem domain/accuracy.ts. */
const wapeSql = (err: string, tt: string) => `
  CASE WHEN ${tt} IS NULL OR ${err} IS NULL THEN NULL
       WHEN ${tt} = 0 THEN CASE WHEN ${err} = 0 THEN 100 ELSE 0 END
       ELSE greatest(0, (1 - (${err})::float8 / (${tt})::float8) * 100) END`;

export interface RefreshResult {
  skuRows: number;
  cnRows: number;
}

export class AccuracyRepository {
  constructor(private readonly pool: Pool) {}

  /** Tình trạng nguồn và bảng accuracy cho từng tháng trong `periods`. */
  async monthStates(periods: string[]): Promise<MonthState[]> {
    const { rows } = await this.pool.query<{
      period: string; source_rows: number; source_updated_at: Date | null;
      acc_rows: number; acc_computed_at: Date | null; acc_closed: boolean | null;
    }>(
      `
      WITH p AS (SELECT unnest($1::date[]) AS period_start)
      SELECT to_char(p.period_start, 'YYYY-MM-DD') AS period,
             COALESCE(s.n, 0)::int AS source_rows, s.updated_at AS source_updated_at,
             COALESCE(a.n, 0)::int AS acc_rows, a.computed_at AS acc_computed_at,
             CASE WHEN a.n IS NULL OR a.closed_min <> a.closed_max THEN NULL
                  ELSE a.closed_min END AS acc_closed
        FROM p
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, max(last_updated_at) AS updated_at
            FROM public.branch_forecast bf WHERE bf.period_start = p.period_start
        ) s ON s.n > 0
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, min(computed_at) AS computed_at,
                 bool_and(closed) AS closed_min, bool_or(closed) AS closed_max
            FROM public.forecast_accuracy_sku fa WHERE fa.period_start = p.period_start
        ) a ON a.n > 0
       ORDER BY 1
      `,
      [periods],
    );
    return rows.map((r) => ({
      period: r.period,
      sourceRows: r.source_rows,
      sourceUpdatedAt: r.source_updated_at,
      accRows: r.acc_rows,
      accComputedAt: r.acc_computed_at,
      accClosed: r.acc_closed,
    }));
  }

  /** Dựng lại accuracy của MỘT tháng (`period` = YYYY-MM-DD ngày 1). */
  async refreshMonth(period: string, closed: boolean): Promise<RefreshResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Khoá theo tháng: hai lượt (cron + chạy tay) cùng dựng một tháng sẽ đợi nhau
      // thay vì chèn trùng khoá.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forecast_accuracy:${period}`]);
      await client.query('DELETE FROM public.forecast_accuracy_cn  WHERE period_start = $1::date', [period]);
      await client.query('DELETE FROM public.forecast_accuracy_sku WHERE period_start = $1::date', [period]);

      const sku = await client.query(
        `
        INSERT INTO public.forecast_accuracy_sku (
          cn_code, sku_code, period_start, scored, closed,
          tt, fc, ma3, abs_err_fc, abs_err_ma3, fc_raw, ma3_raw, acc_fc, acc_ma3, computed_at)
        SELECT cn_code, sku_code, period_start, s, $2::boolean,
               CASE WHEN s THEN actual_qty END,
               CASE WHEN s THEN fc_qty END,
               CASE WHEN s THEN ma3 END,
               CASE WHEN s THEN abs(actual_qty - fc_qty) END,
               CASE WHEN s THEN abs(actual_qty - ma3) END,
               fc_qty, ma3,
               CASE WHEN s AND $2::boolean THEN ${wapeSql('abs(actual_qty - fc_qty)', 'actual_qty')} END,
               CASE WHEN s AND $2::boolean THEN ${wapeSql('abs(actual_qty - ma3)', 'actual_qty')} END,
               now()
          FROM (SELECT *, (${SCORED}) AS s
                  FROM public.branch_forecast WHERE period_start = $1::date) b
        `,
        [period, closed],
      );

      // Cấp CN gộp từ bảng sku vừa dựng — một nguồn duy nhất cho cả hai grain.
      const cn = await client.query(
        `
        INSERT INTO public.forecast_accuracy_cn (
          cn_code, period_start, closed, sku_count, scored_count,
          tt, fc, ma3, abs_err_fc, abs_err_ma3, fc_raw, ma3_raw,
          acc_fc, acc_ma3, sku_acc_fc, sku_acc_ma3, computed_at)
        SELECT cn_code, period_start, $2::boolean, n, n_scored,
               tt, fc, ma3, abs_err_fc, abs_err_ma3, fc_raw, ma3_raw,
               CASE WHEN $2::boolean THEN ${wapeSql('abs(fc - tt)', 'tt')} END,
               CASE WHEN $2::boolean THEN ${wapeSql('abs(ma3 - tt)', 'tt')} END,
               CASE WHEN $2::boolean THEN ${wapeSql('abs_err_fc', 'tt')} END,
               CASE WHEN $2::boolean THEN ${wapeSql('abs_err_ma3', 'tt')} END,
               now()
          FROM (SELECT cn_code, period_start,
                       count(*) AS n, count(*) FILTER (WHERE scored) AS n_scored,
                       sum(tt) AS tt, sum(fc) AS fc, sum(ma3) AS ma3,
                       sum(abs_err_fc) AS abs_err_fc, sum(abs_err_ma3) AS abs_err_ma3,
                       sum(fc_raw) AS fc_raw, sum(ma3_raw) AS ma3_raw
                  FROM public.forecast_accuracy_sku
                 WHERE period_start = $1::date
                 GROUP BY cn_code, period_start) g
        `,
        [period, closed],
      );

      await client.query('COMMIT');
      return { skuRows: sku.rowCount ?? 0, cnRows: cn.rowCount ?? 0 };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
