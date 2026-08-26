-- Đã tính lại chưa? Đã ghi đè vào DB chưa?
--
-- Ba dấu vết trả lời câu đó, không cần tin vào log của app:
--   last_updated_by  = 'forecast-app'  → do app này ghi (SCP ghi thì là tên khác)
--   last_updated_at                    → ghi lúc nào
--   version                            → tăng 1 mỗi lần giá trị THẬT SỰ đổi
--   branch_forecast_history            → đổi từ gì sang gì, ai đổi, vì sao
--
-- Chạy: psql -f queries/audit-fc-ma3.sql

\echo ''
\echo '=== 1. Mỗi tháng: ai ghi lần cuối, lúc nào, bao nhiêu dòng có FC/MA3/TT ==='
SELECT TO_CHAR(period_start, 'YYYY-MM')      AS thang,
       count(*)                              AS dong,
       count(fc_qty)                         AS co_fc,
       count(ma3)                            AS co_ma3,
       count(actual_qty)                     AS co_tt,
       max(last_updated_at)                  AS ghi_lan_cuoi,
       string_agg(DISTINCT last_updated_by, ', ' ORDER BY last_updated_by) AS nguoi_ghi,
       string_agg(DISTINCT source, ', ' ORDER BY source)                   AS source,
       max(version)                          AS version_cao_nhat
  FROM branch_forecast
 GROUP BY 1
 ORDER BY 1 DESC
 LIMIT 15;

\echo ''
\echo '=== 2. Dòng nào CHƯA được app này ghi (còn số của engine cũ) ==='
SELECT TO_CHAR(period_start, 'YYYY-MM') AS thang,
       last_updated_by,
       source,
       count(*) AS dong,
       count(ma3) AS co_ma3,
       max(last_updated_at) AS ghi_lan_cuoi
  FROM branch_forecast
 GROUP BY 1, 2, 3
 ORDER BY 1 DESC, 4 DESC
 LIMIT 25;

\echo ''
\echo '=== 3. Lượt ghi gần nhất của app này (gom theo phút) ==='
-- changed_fields là JSONB {"fc_qty": true, "ma3": false, ...}, KHÔNG phải array —
-- dùng ANY() sẽ lỗi "requires array on right side".
SELECT date_trunc('minute', changed_at)                               AS luot,
       changed_by,
       count(*)                                                      AS dong_ghi,
       count(*) FILTER (WHERE (changed_fields->>'fc_qty')::bool)      AS doi_fc,
       count(*) FILTER (WHERE (changed_fields->>'ma3')::bool)         AS doi_ma3,
       count(*) FILTER (WHERE (changed_fields->>'actual_qty')::bool)  AS doi_tt,
       count(*) FILTER (WHERE change_type = 'INSERT')                 AS them_moi,
       min(reason)                                                    AS ly_do
  FROM branch_forecast_history
 GROUP BY 1, 2
 ORDER BY 1 DESC
 LIMIT 20;

\echo ''
\echo '=== 5. CÂU TRẢ LỜI DỨT KHOÁT: DB có khớp số tính lại không? ==='
\echo '(tính lại B1/B2/B3 ngay trong SQL rồi so với cột trong bảng)'
WITH b AS (
  SELECT st.branch_code_0 AS cn, s.sku_code AS sku,
         COALESCE(sum(st.quantity) FILTER (WHERE st.doc_date >= '2026-08-01' AND st.doc_date < '2026-09-01'), 0) b1,
         COALESCE(sum(st.quantity) FILTER (WHERE st.doc_date >= '2026-07-01' AND st.doc_date < '2026-08-01'), 0) b2,
         COALESCE(sum(st.quantity) FILTER (WHERE st.doc_date >= '2026-06-01' AND st.doc_date < '2026-07-01'), 0) b3
    FROM f2_supply.sales_transaction_v2 st
    JOIN public.sku s     ON st.item_code = s.bravo_sku
    JOIN public.channel c ON c.cn_code = st.branch_code_0
   WHERE lower(st.unit) = 'm2' AND st.quantity > 0
     AND st.doc_date >= '2026-06-01' AND st.doc_date < '2026-09-01'
   GROUP BY 1, 2
)
SELECT count(*)                                                          AS cap_co_ban,
       count(f.id)                                                       AS co_dong_trong_db,
       count(*) - count(f.id)                                            AS thieu_dong,
       count(*) FILTER (WHERE f.ma3 IS NULL)                             AS ma3_con_null,
       count(*) FILTER (WHERE abs(f.ma3 - round((b.b1+b.b2+b.b3)/3, 2)) > 0.01)               AS ma3_lech,
       count(*) FILTER (WHERE abs(f.fc_qty - round((0.6*b.b1+0.3*b.b2+0.1*b.b3)/30*30, 2)) > 0.01) AS fc_lech
  FROM b
  LEFT JOIN branch_forecast f
         ON f.cn_code = b.cn AND f.sku_code = b.sku
        AND f.period_start = DATE '2026-09-01';

\echo ''
\echo '=== 4. Một cặp cụ thể: FC/MA3 đổi từ gì sang gì ==='
\echo '(sửa cn_code / sku_code / period_start bên dưới cho cặp bạn muốn soi)'
SELECT h.changed_at,
       h.changed_by,
       h.old_fc_qty, h.new_fc_qty,
       h.old_ma3,    h.new_ma3,
       h.old_actual_qty, h.new_actual_qty,
       h.changed_fields,
       h.reason
  FROM branch_forecast_history h
 WHERE h.cn_code = '049'
   AND h.period_start = DATE '2026-09-01'
 ORDER BY h.changed_at DESC
 LIMIT 20;
