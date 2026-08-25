import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Migration runner tối giản: chạy các file .sql theo thứ tự tên, mỗi file một
 * transaction, ghi lại tên file đã chạy để không chạy lại lần sau.
 *
 * Dự án SCP không có migration runner tập trung nên app này tự quản phần schema
 * mà nó thêm vào.
 */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.forecast_app_migration (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM public.forecast_app_migration',
    );
    const done = new Set(rows.map((r) => r.filename));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let applied = 0;
    for (const file of files) {
      if (done.has(file)) {
        console.log(`  ⏭  ${file} (đã chạy)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.forecast_app_migration (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`  ✓  ${file}`);
        applied += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} lỗi: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(applied === 0 ? 'Schema đã đúng, không có gì để chạy.' : `Đã chạy ${applied} migration.`);
  } finally {
    client.release();
  }
}
