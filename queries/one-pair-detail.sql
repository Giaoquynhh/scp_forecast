-- Soi một cặp CN × SKU: chuỗi FC / MA3 / TT theo tháng, kèm phần kiểm chứng
-- công thức FC bằng số bán gốc.
--
-- Chạy:
--   psql -h localhost -U postgres -d test_scp \
--        -v cn="'073'" -v sku="'40.L1.3060.UGC3602'" -v thang="'2026-09-01'" \
--        -f queries/one-pair-detail.sql

-- 1) Chuỗi theo tháng của cặp này.
SELECT to_char(bf.period_start, 'YYYY-MM')          AS thang,
       bf.fc_qty                                     AS fc,
       bf.ma3,
       bf.actual_qty                                 AS tt,
       round(bf.actual_qty - bf.fc_qty, 2)           AS tt_tru_fc,
       bf.source,
       bf.last_updated_by,
       bf.version
  FROM branch_forecast bf
 WHERE bf.cn_code = :cn
   AND bf.sku_code = :sku
 ORDER BY bf.period_start;

-- 2) Kiểm chứng FC và MA3 của tháng đích bằng SỐ BÁN GỐC.
--
--    Lưu ý: FC/MA3 đọc thẳng từ sales_transaction_v2, KHÔNG đọc cột actual_qty.
--    TT của tháng đã qua bị đóng băng nên hai nguồn có thể lệch nhau vài m² —
--    cộng tay 3 cột TT rồi so với FC sẽ không khớp, và đó không phải lỗi.
WITH t AS (SELECT :thang::date AS tgt),
blk AS (
  SELECT
    round(sum(st.quantity) FILTER (
      WHERE st.doc_date >= (SELECT tgt - INTERVAL '1 month' FROM t)
        AND st.doc_date <  (SELECT tgt FROM t)), 2) AS b1,
    round(sum(st.quantity) FILTER (
      WHERE st.doc_date >= (SELECT tgt - INTERVAL '2 months' FROM t)
        AND st.doc_date <  (SELECT tgt - INTERVAL '1 month' FROM t)), 2) AS b2,
    round(sum(st.quantity) FILTER (
      WHERE st.doc_date >= (SELECT tgt - INTERVAL '3 months' FROM t)
        AND st.doc_date <  (SELECT tgt - INTERVAL '2 months' FROM t)), 2) AS b3
  FROM f2_supply.sales_transaction_v2 st
  JOIN public.sku s ON st.item_code = s.bravo_sku
  CROSS JOIN t
 WHERE lower(st.unit) = 'm2' AND st.quantity > 0
   AND st.branch_code_0 = :cn
   AND s.sku_code = :sku
   AND st.doc_date >= t.tgt - INTERVAL '3 months'
   AND st.doc_date <  t.tgt
)
SELECT blk.b1, blk.b2, blk.b3,
       round(0.6 * COALESCE(b1,0) + 0.3 * COALESCE(b2,0) + 0.1 * COALESCE(b3,0), 2) AS weighted,
       round((0.6 * COALESCE(b1,0) + 0.3 * COALESCE(b2,0) + 0.1 * COALESCE(b3,0)) / 30
             * date_part('days', (date_trunc('month', :thang::date)
                                  + INTERVAL '1 month - 1 day'))::numeric, 2)       AS fc_tinh_tay,
       round((COALESCE(b1,0) + COALESCE(b2,0) + COALESCE(b3,0)) / 3.0, 2)           AS ma3_tinh_tay,
       bf.fc_qty AS fc_trong_db,
       bf.ma3    AS ma3_trong_db
  FROM blk
  LEFT JOIN branch_forecast bf
    ON bf.cn_code = :cn AND bf.sku_code = :sku AND bf.period_start = :thang::date;

-- 3) Lịch sử thay đổi của cặp này — ai sửa, sửa gì, lúc nào.
SELECT h.changed_at, h.change_type, h.changed_by, h.source,
       h.old_fc_qty, h.new_fc_qty, h.old_ma3, h.new_ma3,
       h.old_actual_qty, h.new_actual_qty, h.reason
  FROM branch_forecast_history h
 WHERE h.cn_code = :cn
   AND h.sku_code = :sku
   AND h.period_start = :thang::date
 ORDER BY h.changed_at DESC
 LIMIT 10;
