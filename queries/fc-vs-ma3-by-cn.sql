-- So sánh FC với MA3 theo từng chi nhánh cho một tháng.
--
-- Chạy:
--   psql -h localhost -U postgres -d test_scp -v thang="'2026-09-01'" -f queries/fc-vs-ma3-by-cn.sql
-- hoặc thay thẳng :thang bằng DATE '2026-09-01'.
--
-- Đọc kết quả:
--   chenh < 0  → FC thấp hơn MA3: lượng bán đang có xu hướng GIẢM, vì FC dồn 60%
--                trọng số vào tháng gần nhất còn MA3 cào bằng cả 3 tháng.
--   chenh > 0  → xu hướng TĂNG.
--
-- ⚠ Chạy giữa tháng thì khối B1 (tháng liền trước) có thể chưa đủ ngày, làm FC
--   thấp giả tạo. Xem cột ngay_cuoi ở truy vấn thứ hai bên dưới trước khi kết luận.

\set thang :thang

SELECT bf.cn_code,
       c.cn_name,
       count(*) FILTER (WHERE bf.fc_qty > 0)               AS sku,
       round(sum(bf.fc_qty))                               AS fc,
       round(sum(bf.ma3))                                  AS ma3,
       round(sum(bf.fc_qty) - sum(bf.ma3))                 AS chenh,
       round((sum(bf.fc_qty) - sum(bf.ma3))
             / NULLIF(sum(bf.ma3), 0) * 100, 1)            AS pct
  FROM branch_forecast bf
  LEFT JOIN channel c ON c.cn_code = bf.cn_code
 WHERE bf.period_start = :thang::date
   AND (bf.fc_qty > 0 OR bf.ma3 > 0)
 GROUP BY 1, 2
 ORDER BY fc DESC;

-- Tổng toàn hệ thống + bao nhiêu chi nhánh đang tăng / giảm.
WITH per_cn AS (
  SELECT cn_code, sum(fc_qty) AS fc, sum(ma3) AS ma3
    FROM branch_forecast
   WHERE period_start = :thang::date
     AND (fc_qty > 0 OR ma3 > 0)
   GROUP BY 1
)
SELECT count(*)                                        AS so_cn,
       count(*) FILTER (WHERE fc > ma3)                AS fc_cao_hon,
       count(*) FILTER (WHERE fc < ma3)                AS fc_thap_hon,
       round(sum(fc))                                  AS tong_fc,
       round(sum(ma3))                                 AS tong_ma3,
       round((sum(fc) - sum(ma3)) / sum(ma3) * 100, 1) AS pct_tong
  FROM per_cn;

-- Kiểm tra 3 khối đã đủ ngày chưa — nếu ngay_cuoi của tháng gần nhất chưa phải
-- ngày cuối tháng thì FC đang bị thấp giả tạo.
SELECT to_char(doc_date, 'YYYY-MM') AS thang,
       count(*)                     AS dong,
       round(sum(quantity))         AS m2,
       max(doc_date)                AS ngay_cuoi
  FROM f2_supply.sales_transaction_v2
 WHERE lower(unit) = 'm2'
   AND quantity > 0
   AND doc_date >= (:thang::date - INTERVAL '3 months')
   AND doc_date <  :thang::date
 GROUP BY 1
 ORDER BY 1;
