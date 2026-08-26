-- Khôi phục fc_qty về giá trị trước một lượt ghi, GIỮ NGUYÊN ma3.
--
-- Bối cảnh: lượt 2026-08-26 17:39–17:40 chạy `--only fc` cho 2026-01..08, ghi đè
-- fc_qty của engine cũ. Chỉ cần MA3, không cần FC mới. `branch_forecast_history`
-- giữ old_fc_qty của từng dòng nên khôi phục được chính xác.
--
-- An toàn được vì trong cửa sổ đó MỖI DÒNG CHỈ BỊ ĐỤNG 1 LẦN (71.738/71.738) —
-- nếu bị đụng nhiều lần thì phải lấy bản cũ NHẤT, không phải bản bất kỳ.
--
-- old_fc_qty NULL là giá trị cũ ĐÚNG của 381 dòng (chúng vốn chưa có FC), nên
-- khôi phục phải ghi NULL chứ không được bỏ qua chúng.
--
-- Chạy thử:  psql -f queries/restore-fc-from-history.sql   (mặc định ROLLBACK)
-- Ghi thật:  sửa ROLLBACK ở cuối thành COMMIT.

\set cua_so_tu '2026-08-26 17:38:00+07'
\set cua_so_den '2026-08-26 17:45:00+07'

BEGIN;

\echo '=== TRƯỚC khi khôi phục ==='
SELECT TO_CHAR(period_start,'YYYY-MM') AS thang,
       count(fc_qty) AS fc_cnt, round(sum(fc_qty),2) AS fc_sum,
       count(ma3)    AS ma3_cnt, round(sum(ma3),2)   AS ma3_sum
  FROM branch_forecast
 WHERE period_start >= DATE '2026-01-01' AND period_start < DATE '2026-09-01'
 GROUP BY 1 ORDER BY 1;

-- Một dòng lịch sử cho một forecast_id trong cửa sổ, nên join thẳng được.
WITH ban_cu AS (
  SELECT h.forecast_id, h.old_fc_qty
    FROM branch_forecast_history h
   WHERE h.changed_at >= TIMESTAMPTZ :'cua_so_tu'
     AND h.changed_at <  TIMESTAMPTZ :'cua_so_den'
     AND h.changed_by = 'forecast-app'
     AND (h.changed_fields->>'fc_qty')::bool
)
UPDATE branch_forecast f
   SET fc_qty          = c.old_fc_qty,
       last_updated_by = 'restore-fc-20260826',
       last_updated_at = NOW(),
       version         = f.version + 1
  FROM ban_cu c
 WHERE f.id = c.forecast_id
   AND f.fc_qty IS DISTINCT FROM c.old_fc_qty;

\echo ''
\echo '=== SAU khi khôi phục (fc_sum phải về số cũ, ma3 giữ nguyên) ==='
SELECT TO_CHAR(period_start,'YYYY-MM') AS thang,
       count(fc_qty) AS fc_cnt, round(sum(fc_qty),2) AS fc_sum,
       count(ma3)    AS ma3_cnt, round(sum(ma3),2)   AS ma3_sum
  FROM branch_forecast
 WHERE period_start >= DATE '2026-01-01' AND period_start < DATE '2026-09-01'
 GROUP BY 1 ORDER BY 1;

ROLLBACK;
