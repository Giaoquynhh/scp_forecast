import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import { CFG } from '../config.js';

/**
 * numeric của Postgres mặc định về JS dạng string để khỏi mất chính xác.
 * App này chỉ cộng/nhân số m² cỡ vài nghìn nên Number là đủ và tiện hơn nhiều.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/**
 * Cấu hình SSL theo DB_SSL:
 *
 *   disable      không mã hóa. Chỉ dùng cho DB chạy trên chính máy này.
 *   require      có mã hóa nhưng KHÔNG kiểm chứng certificate — chặn được nghe
 *                lén, nhưng không chặn được kẻ đứng giữa giả danh server.
 *   verify-full  mã hóa + kiểm chứng certificate và tên host. Cần DB_SSL_CA trỏ
 *                tới file CA. Đây là mức nên dùng khi đi qua Internet.
 *
 * Mặc định `disable` vì DB local hiện tại có ssl = off; đổi sang verify-full khi
 * trỏ sang VPS.
 */
function sslConfig(): ConnectionOptions | false {
  switch (CFG.db.ssl) {
    case 'disable':
      return false;

    case 'require':
      return { rejectUnauthorized: false };

    case 'verify-full': {
      if (!CFG.db.sslCa) {
        throw new Error('DB_SSL=verify-full thì phải khai DB_SSL_CA trỏ tới file CA');
      }
      let ca: string;
      try {
        ca = readFileSync(CFG.db.sslCa, 'utf8');
      } catch (err) {
        throw new Error(
          `Không đọc được DB_SSL_CA (${CFG.db.sslCa}): ${err instanceof Error ? err.message : err}`,
        );
      }
      return { ca, rejectUnauthorized: true, servername: CFG.db.host };
    }

    default:
      throw new Error(`DB_SSL phải là disable | require | verify-full (nhận được: ${CFG.db.ssl})`);
  }
}

export const pool = new pg.Pool({
  host: CFG.db.host,
  port: CFG.db.port,
  database: CFG.db.database,
  user: CFG.db.user,
  password: CFG.db.password,
  ssl: sslConfig(),
  max: 4,
});

/** In ra kết nối đang mã hóa hay không — để không phải đoán. */
export async function describeConnection(): Promise<string> {
  const { rows } = await pool.query<{ ssl: boolean; version: string | null; cipher: string | null }>(
    'SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
  );
  const r = rows[0];
  if (!r?.ssl) return 'không mã hóa';
  return `SSL ${r.version ?? '?'} · ${r.cipher ?? '?'}`;
}
