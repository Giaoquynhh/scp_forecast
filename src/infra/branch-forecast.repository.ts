import type pg from 'pg';
import type {
  ActualLine, ForecastRecord, ForecastWriter, WriteOptions, WriteResult,
} from '../domain/types.js';

interface StoredRow {
  id: string;
  cn_code: string;
  sku_code: string;
  period_start: string;
  fc_qty: number | null;
  actual_qty: number | null;
  accuracy_pct: number | null;
  ma3: number | null;
  version: number;
  inserted?: boolean;
}

/**
 * Ghi xuống branch_forecast theo đúng hợp đồng mà SCP đang dùng ở
 * ForecastService.upsert() — upsert theo khóa nghiệp vụ, ghi lịch sử, tăng
 * version — để lịch sử liền mạch dù bên ghi đã đổi.
 *
 * Cột fc_qty_rounded / actual_qty_rounded là GENERATED, Postgres tự tính.
 */
export class BranchForecastRepository implements ForecastWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chunkSize: number,
  ) {}

  async write(records: ForecastRecord[], opts: WriteOptions): Promise<WriteResult> {
    const result: WriteResult = { inserted: 0, updated: 0, skipped: 0, notFound: 0 };
    if (records.length === 0) return result;

    for (let i = 0; i < records.length; i += this.chunkSize) {
      const wholeChunk = records.slice(i, i + this.chunkSize);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const stored = await this.loadExisting(client, wholeChunk);

        // updateOnly: cặp chưa có dòng thì bỏ ra khỏi lô trước khi so sánh, để
        // ON CONFLICT không có cơ hội INSERT.
        const chunk = opts.updateOnly
          ? wholeChunk.filter((r) => stored.has(keyOf(r)))
          : wholeChunk;
        result.notFound += wholeChunk.length - chunk.length;

        const todo = chunk.filter((r) => this.hasChange(r, stored.get(keyOf(r))));
        result.skipped += chunk.length - todo.length;

        if (todo.length > 0) {
          const written = await this.upsert(client, todo, opts);
          await this.appendHistory(client, written, stored, opts);
          for (const row of written) {
            if (row.inserted) result.inserted += 1;
            else result.updated += 1;
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return result;
  }

  async pairsWithActuals(fromMonth: string, toMonth: string): Promise<ActualLine[]> {
    const { rows } = await this.pool.query<{
      cn_code: string; sku_code: string; period_start: string; actual_qty: number;
    }>(
      `SELECT cn_code, sku_code,
              TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start,
              actual_qty
         FROM public.branch_forecast
        WHERE period_start >= $1::date
          AND period_start <= $2::date
          AND actual_qty IS NOT NULL
          AND actual_qty <> 0`,
      [fromMonth, toMonth],
    );
    return rows.map((r) => ({
      cnCode: r.cn_code,
      skuCode: r.sku_code,
      periodStart: r.period_start,
      actualQty: r.actual_qty,
    }));
  }

  async pairsWithForecast(periodStart: string): Promise<Array<{
    cnCode: string; skuCode: string; periodStart: string;
  }>> {
    const { rows } = await this.pool.query<{
      cn_code: string; sku_code: string; period_start: string;
    }>(
      `SELECT cn_code, sku_code, TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start
         FROM public.branch_forecast
        WHERE period_start = $1::date
          AND (COALESCE(fc_qty, 0) <> 0 OR COALESCE(ma3, 0) <> 0)`,
      [periodStart],
    );
    return rows.map((r) => ({
      cnCode: r.cn_code,
      skuCode: r.sku_code,
      periodStart: r.period_start,
    }));
  }

  // ── các bước bên trong một transaction ─────────────────────────────────

  /** Đọc giá trị cũ để vừa so sánh vừa ghi diff vào lịch sử. */
  private async loadExisting(
    client: pg.PoolClient,
    chunk: ForecastRecord[],
  ): Promise<Map<string, StoredRow>> {
    const params: unknown[] = [];
    const tuples = chunk
      .map((r) => {
        const b = params.length;
        params.push(r.cnCode, r.skuCode, r.periodStart);
        return `($${b + 1}, $${b + 2}, $${b + 3}::date)`;
      })
      .join(',');

    const { rows } = await client.query<StoredRow>(
      `SELECT id, cn_code, sku_code, TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start,
              fc_qty, actual_qty, accuracy_pct, ma3, version
         FROM branch_forecast
        WHERE (cn_code, sku_code, period_start) IN (${tuples})`,
      params,
    );

    const map = new Map<string, StoredRow>();
    for (const r of rows) map.set(keyOf({ cnCode: r.cn_code, skuCode: r.sku_code, periodStart: r.period_start }), r);
    return map;
  }

  /**
   * Dòng đã đúng giá trị thì bỏ qua. Không có bước này thì mỗi lượt chạy sẽ tăng
   * version và đẻ ~9.500 bản ghi lịch sử với changed_fields toàn false.
   */
  private hasChange(record: ForecastRecord, old: StoredRow | undefined): boolean {
    if (!old) return true;
    const same = (incoming: number | null | undefined, current: number | null) =>
      incoming === undefined || incoming === null || incoming === current;
    return !(
      same(record.fcQty, old.fc_qty) &&
      same(record.actualQty, old.actual_qty) &&
      same(record.ma3, old.ma3)
    );
  }

  private async upsert(
    client: pg.PoolClient,
    todo: ForecastRecord[],
    opts: WriteOptions,
  ): Promise<StoredRow[]> {
    const values: unknown[] = [];
    const placeholders = todo.map((r) => {
      const b = values.length;
      values.push(
        r.cnCode, r.skuCode, r.periodStart,
        r.fcQty ?? null, r.actualQty ?? null, r.ma3 ?? null,
        opts.changedBy, opts.source,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}::date, $${b + 4}::numeric,` +
             ` $${b + 5}::numeric, $${b + 6}::numeric, $${b + 7}, $${b + 8})`;
    });

    const { rows } = await client.query<StoredRow>(
      `INSERT INTO branch_forecast
         (cn_code, sku_code, period_start, fc_qty, actual_qty, ma3, last_updated_by, source)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (cn_code, sku_code, period_start) DO UPDATE SET
         fc_qty          = COALESCE(EXCLUDED.fc_qty,     branch_forecast.fc_qty),
         actual_qty      = COALESCE(EXCLUDED.actual_qty, branch_forecast.actual_qty),
         ma3             = COALESCE(EXCLUDED.ma3,        branch_forecast.ma3),
         source          = ${opts.keepSource ? 'branch_forecast.source' : 'EXCLUDED.source'},
         last_updated_by = EXCLUDED.last_updated_by,
         last_updated_at = NOW(),
         version         = branch_forecast.version + 1
       RETURNING id, cn_code, sku_code,
                 TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start,
                 fc_qty, actual_qty, accuracy_pct, ma3, version,
                 (xmax = 0) AS inserted`,
      values,
    );
    return rows;
  }

  private async appendHistory(
    client: pg.PoolClient,
    written: StoredRow[],
    stored: Map<string, StoredRow>,
    opts: WriteOptions,
  ): Promise<void> {
    const values: unknown[] = [];
    const placeholders = written.map((row) => {
      const old = stored.get(
        keyOf({ cnCode: row.cn_code, skuCode: row.sku_code, periodStart: row.period_start }),
      ) ?? null;

      const changedFields = {
        fc_qty: (old?.fc_qty ?? null) !== row.fc_qty,
        actual_qty: (old?.actual_qty ?? null) !== row.actual_qty,
        accuracy_pct: (old?.accuracy_pct ?? null) !== row.accuracy_pct,
        ma3: (old?.ma3 ?? null) !== row.ma3,
      };

      const b = values.length;
      values.push(
        row.id, row.cn_code, row.sku_code, row.period_start,
        old?.fc_qty ?? null, old?.actual_qty ?? null, old?.accuracy_pct ?? null, old?.ma3 ?? null,
        row.fc_qty, row.actual_qty, row.accuracy_pct, row.ma3,
        JSON.stringify(changedFields), row.inserted ? 'INSERT' : 'UPDATE', row.version,
        opts.source, opts.changedBy, opts.reason ?? null,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::date,
               $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8},
               $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12},
               $${b + 13}::jsonb, $${b + 14}, $${b + 15},
               $${b + 16}, $${b + 17}, $${b + 18})`;
    });

    if (placeholders.length === 0) return;

    await client.query(
      `INSERT INTO branch_forecast_history
         (forecast_id, cn_code, sku_code, period_start,
          old_fc_qty, old_actual_qty, old_accuracy_pct, old_ma3,
          new_fc_qty, new_actual_qty, new_accuracy_pct, new_ma3,
          changed_fields, change_type, version,
          source, changed_by, reason)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }
}

function keyOf(r: { cnCode: string; skuCode: string; periodStart: string }): string {
  return `${r.cnCode}|${r.skuCode}|${r.periodStart}`;
}
