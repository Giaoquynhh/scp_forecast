import { round2 } from './forecast-formula.js';

/**
 * TB trượt bán `n` ngày gần nhất — nghiệp vụ thuần, không SQL, không import pg.
 *
 *   salesMa = ( Σ m² bán trong n ngày gần nhất / n ) × 30      → m²/THÁNG
 *
 * Đây là cột "TB trượt Sales n ngày gần nhất" của màn F1-B3 bên SCP. Trước đây SCP
 * tính live bằng một CTE quét `sales_transaction_v2` trong chính câu SQL dựng bảng
 * plan — mỗi lần load bảng là một lần quét, và đó là một trong các nguồn timeout.
 * Nay app này tính sẵn mỗi 02:00 và ghi vào `branch_forecast.sales_ma_qty`, SCP chỉ
 * còn SELECT.
 *
 * ── Vì sao nhân 30 rồi mới lưu ────────────────────────────────────────────────
 * Số nguyên bản của phép trượt là m²/NGÀY, và lưu nguyên bản thường là lựa chọn
 * đúng. Ở đây thì không: mục đích của cột là để bên đọc khỏi phải tính. Lưu m²/ngày
 * nghĩa là mỗi consumer phải nhớ nhân 30 — mà chính SCP đã có sẵn một bug cùng họ
 * (nhân 30 hai lần làm deduct phồng 30×, xem chú thích ở prod-lot-sizing.service.ts).
 * Lưu đúng con số cột đang hiển thị thì không còn chỗ nào để quên.
 *
 * ── Vì sao mẫu số là `days` chứ không phải số ngày thật có bán ────────────────
 * Chia cho cả cửa sổ, kể cả ngày không bán — đó là định nghĩa "trung bình trượt".
 * Chia cho số ngày CÓ bán sẽ biến nó thành "trung bình mỗi lần bán", và một mã bán
 * 1 ngày trong 90 ngày sẽ có TB ngang mã bán đều mỗi ngày.
 */

/** Quy ngày → tháng. Khớp DAYS_PER_MONTH của SCP (prod-lot-sizing.service.ts). */
export const DAYS_PER_MONTH = 30;

/** Cửa sổ mặc định khi `planning.ma_months` thiếu hoặc không hợp lệ. */
export const SALES_MA_DEFAULT_DAYS = 90;

/**
 * TẠM THỜI: mọi lượt tính đều dùng 90 ngày, bất kể người dùng đặt `planning.ma_months`
 * bằng bao nhiêu.
 *
 * Lý do: cột được tính sẵn mỗi đêm, nên n phải cố định tại thời điểm ghi. Cho n đổi tự
 * do trong khi số chỉ làm mới mỗi 24h nghĩa là có những khoảng thời gian nhãn cột nói
 * một đằng còn số nói một nẻo — mà cột này đang ăn thẳng vào "Lượng đặt bán đầu" và cờ
 * "Khẩn cấp" (deduct_mode = MA_TT). Khoá một con số cho tới khi chốt được cách xử lý.
 *
 * Bỏ khoá: đặt false. Toàn bộ đường đọc config đã sẵn sàng và có test — không phải viết
 * lại gì, chỉ là lúc đó phải trả lời được "đổi n xong thì bao giờ số mới đúng".
 */
export const SALES_MA_LOCK_DEFAULT = true;

/**
 * Trần cứng, khớp MA_TT_MAX_DAYS của SCP. Hai bên phải cùng một trần: SCP kẹp ở
 * popup nhập liệu, app này kẹp lúc tính — lệch trần thì người dùng nhập 200 rồi
 * nhìn một con số không tương ứng với gì cả.
 */
export const SALES_MA_MAX_DAYS = 150;

/**
 * Giá trị `planning.ma_months` (đọc từ `system_config` của SCP) → số ngày dùng thật.
 *
 * Tên config nói "months" nhưng ý nghĩa là NGÀY — di sản, phía SCP cũng đang có
 * `TODO(ma-days)` để đổi tên. Đọc chung một key để đúng một nguồn sự thật: người
 * dùng đổi n ở popup "Điều chỉnh tham số tính toán" thì lượt cron kế tiếp tính theo
 * n đó, không phải sửa hai chỗ.
 *
 * Thiếu / không phải số nguyên / < 1 → mặc định 90. Lớn hơn trần → kẹp về trần.
 */
export function resolveSalesMaDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return SALES_MA_DEFAULT_DAYS;
  return Math.min(n, SALES_MA_MAX_DAYS);
}

/** Σ m² của cửa sổ → m²/tháng. Làm tròn 2 chữ số khớp numeric(15,2) của cột. */
export function salesMaMonthly(totalM2: number, days: number): number {
  if (days <= 0) throw new RangeError('days phải > 0');
  return round2((totalM2 / days) * DAYS_PER_MONTH);
}
