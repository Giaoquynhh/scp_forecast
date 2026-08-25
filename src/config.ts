import 'dotenv/config';
import type { BlockMode } from './domain/period.js';
import type { Weights } from './domain/forecast-formula.js';

/** Mức bảo mật kết nối tới Postgres. */
export type SslMode = 'disable' | 'require' | 'verify-full';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Thiếu biến môi trường ${name} (xem .env.example)`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} không phải số: ${v}`);
  return n;
}

export const CFG = {
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: num('DB_PORT', 5432),
    database: req('DB_NAME'),
    user: req('DB_USER'),
    password: req('DB_PASSWORD'),
    /**
     * disable | require | verify-full — xem src/infra/db.ts.
     * Mặc định disable vì DB local đang có ssl = off. Trỏ sang VPS thì phải đổi.
     */
    ssl: (process.env.DB_SSL ?? 'disable') as SslMode,
    /** Đường dẫn file CA, bắt buộc khi DB_SSL=verify-full. */
    sslCa: process.env.DB_SSL_CA ?? '',
  },

  /**
   * Trọng số của 3 khối, B1 là khối gần tháng đích nhất.
   *   weighted = w1·B1 + w2·B2 + w3·B3
   */
  weights: [
    num('FC_WEIGHT_B1', 0.6),
    num('FC_WEIGHT_B2', 0.3),
    num('FC_WEIGHT_B3', 0.1),
  ] as Weights,

  /**
   * 'calendar' — B1/B2/B3 là 3 tháng dương lịch liền trước tháng đích
   *              (T = tháng 9 → lấy tháng 8, 7, 6). Đây là cách đã chốt:
   *              app chạy vào mùng 1 nên cả 3 tháng đều đã đóng sổ.
   * 'rolling'  — B1/B2/B3 là 3 cửa sổ 30 ngày đếm ngược từ ngày đầu tháng đích.
   */
  blockMode: (process.env.FC_BLOCK_MODE ?? 'calendar') as BlockMode,

  /** Mẫu số của bước perDay = weighted / divisor. Công thức nghiệp vụ chốt 30. */
  perDayDivisor: num('FC_PER_DAY_DIVISOR', 30),

  /**
   * Số tháng gần nhất được tính lại TT mỗi lượt (tính cả tháng đích).
   * Mặc định 1 = CHỈ tháng hiện tại. Tháng đã qua coi như chốt sổ: dữ liệu bán
   * của nó có sửa về sau cũng không cập nhật lại nữa.
   */
  ttMonths: num('TT_MONTHS', 1),

  /**
   * Vào ngày sinh FC (mùng 1), tính lại TT của tháng liền trước ĐÚNG MỘT LẦN
   * để chốt sổ — nếu không, những ngày cuối tháng sẽ không bao giờ được cộng
   * (02:00 ngày 28 mới cộng tới ngày 27), mà FC tháng mới lại lấy tháng đó làm B1.
   */
  ttCloseoutPrevMonth: (process.env.TT_CLOSEOUT_PREV_MONTH ?? 'true') === 'true',

  /**
   * Giá trị ghi vào branch_forecast.source. Giữ nguyên 2 giá trị SCP đang dùng
   * để mọi thống kê/bộ lọc sẵn có bên F1-B1 không phải sửa; dấu vết của app mới
   * nằm ở last_updated_by.
   */
  sourceFc: process.env.FC_SOURCE ?? 'FORECAST_ENGINE',
  sourceTt: process.env.TT_SOURCE ?? 'SALES_V2_BACKFILL',
  actor: process.env.ACTOR ?? 'forecast-app',

  /** Số dòng mỗi transaction khi ghi. */
  chunkSize: num('CHUNK_SIZE', 500),

  // ── Lịch chạy (chế độ --daemon) ──────────────────────────────────────────
  /** Mặc định 02:00 mỗi ngày. */
  cronSchedule: process.env.CRON_SCHEDULE ?? '0 2 * * *',
  timezone: process.env.TZ_NAME ?? 'Asia/Ho_Chi_Minh',
  /** Ngày trong tháng mà FC được sinh (mùng 1). */
  fcDayOfMonth: num('FC_DAY_OF_MONTH', 1),
  /** true = tính lại FC mỗi lượt cron, không chỉ mùng 1. */
  fcRecomputeDaily: (process.env.FC_RECOMPUTE_DAILY ?? 'false') === 'true',
} as const;
