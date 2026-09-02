import type pg from 'pg';
import type { PlanningConfigReader } from '../domain/types.js';

/**
 * Đọc `system_config` — bảng cấu hình của SCP. CHỈ ĐỌC, không có đường ghi nào:
 * bảng này là của SCP, app này mượn để biết người dùng đang đặt cửa sổ TB trượt
 * bao nhiêu ngày (`planning.ma_months`, tên nói tháng nhưng nghĩa là ngày).
 *
 * Lỗi truy vấn KHÔNG được làm hỏng cả lượt chạy: bảng có thể chưa tồn tại trên một
 * DB dựng riêng để thử. Trả null, để phía gọi rơi về mặc định — mất một tuỳ chỉnh
 * còn hơn mất cả lượt cron.
 */
export class SystemConfigRepository implements PlanningConfigReader {
  constructor(private readonly pool: pg.Pool) {}

  async value(key: string): Promise<string | null> {
    try {
      const { rows } = await this.pool.query<{ config_value: string | null }>(
        'SELECT config_value FROM public.system_config WHERE config_key = $1 LIMIT 1',
        [key],
      );
      return rows[0]?.config_value ?? null;
    } catch (err) {
      console.warn(
        `  ⚠ Không đọc được system_config.${key}` +
        ` (${err instanceof Error ? err.message : err}) — dùng mặc định.`,
      );
      return null;
    }
  }
}
