import 'dotenv/config';

// Ép múi giờ tiến trình theo TZ_NAME. node-cron bấm giờ theo TZ_NAME, nhưng
// planRun/isFcRunDay đọc getDate() theo giờ tiến trình — máy chủ để UTC thì 02:00
// VN là 19:00 hôm trước: cuối tháng bị hiểu là ngày áp chót, không sinh FC.
process.env.TZ = process.env.TZ_NAME ?? 'Asia/Ho_Chi_Minh';

import { parseFcDaySpec, type BlockMode, type FcTargetMode } from './domain/period.js';
import type { Weights } from './domain/forecast-formula.js';

/** Mức bảo mật kết nối tới Postgres. */
export type SslMode = 'disable' | 'require' | 'verify-full';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Thiếu biến môi trường ${name} (xem .env.example)`);
  return v;
}

function parseFcTarget(raw: string): FcTargetMode {
  const v = raw.trim().toLowerCase();
  if (v === 'current' || v === 'next') return v;
  throw new Error(`FC_TARGET phải là current hoặc next (nhận được: ${raw})`);
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
   * Ràng buộc: 2 tháng gần nhất (B1, B2) không bán gì → FC = 0.
   *
   * Để tắt được vì nó là quyết định nghiệp vụ, không phải hằng số toán học — muốn đo
   * "có nó tốt hơn hay không" thì phải chạy được cả hai phía. KHÔNG đụng tới MA3.
   */
  fcZeroWhenDormant: (process.env.FC_ZERO_WHEN_DORMANT ?? 'true') !== 'false',

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
  /**
   * Ngày sinh FC: 1..31, 'last' (ngày cuối tháng) hoặc 'last-N'.
   *
   * Mặc định 'last' — cuối tháng mới là lúc người dùng xem để dự báo cho tháng
   * sau. Bản đầu chạy mùng 1; đổi về bằng FC_DAY_OF_MONTH=1 + FC_TARGET=current.
   */
  fcDay: parseFcDaySpec(process.env.FC_DAY_OF_MONTH ?? 'last'),

  /**
   * Tháng đích của lượt daemon.
   *   'next'    — tháng SAU tháng đang chạy. Đi cùng FC_DAY_OF_MONTH='last'.
   *   'current' — tháng đang chạy. Đi cùng FC_DAY_OF_MONTH=1.
   */
  fcTarget: parseFcTarget(process.env.FC_TARGET ?? 'next'),

  /**
   * Mùng 1, tính lại FC của tháng vừa bắt đầu ĐÚNG MỘT LẦN nữa.
   *
   * Cần thiết vì lượt cuối tháng lấy tháng đang chạy làm B1 mà tháng đó chưa
   * đóng sổ — thiếu 1-2 ngày cuối, mà B1 mang trọng số 0.6. Lượt mùng 1 chạy lại
   * khi B1 đã đủ ngày, nên số cuối tháng là số xem trước, số mùng 1 là số chốt.
   * Tắt = chấp nhận FC hụt vài phần trăm cho tới cuối tháng sau.
   */
  fcFinalizeOnFirst: (process.env.FC_FINALIZE_ON_FIRST ?? 'true') === 'true',

  /** true = tính lại FC mỗi lượt cron, không chỉ ngày sinh FC. */
  fcRecomputeDaily: (process.env.FC_RECOMPUTE_DAILY ?? 'false') === 'true',

  // ── HTTP (chế độ --serve) ────────────────────────────────────────────────
  /** Cổng của server đọc-thuần GET /demand/summary. */
  httpPort: num('HTTP_PORT', 3010),
  /**
   * Địa chỉ lắng nghe. Mặc định 127.0.0.1 — server này KHÔNG có auth, mở ra
   * 0.0.0.0 là ai trong mạng cũng đọc được số bán của toàn bộ chi nhánh.
   */
  httpHost: process.env.HTTP_HOST ?? '127.0.0.1',
} as const;
