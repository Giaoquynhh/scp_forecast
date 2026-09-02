-- sales_ma_qty — TB truot ban n ngay gan nhat, quy ve m2/THANG.
--
--   sales_ma_qty = ( SUM(m2 ban trong n ngay gan nhat) / n ) x 30
--
-- Cot nay thay cho CTE `ma_tt` ma F1-B3 dang tinh live trong cau SQL plan
-- (SmartlogSCP.Backend/src/prod-lot-sizing/prod-lot-sizing.service.ts). Tinh o day,
-- ghi san moi 02:00, de SCP chi con SELECT + SUM.
--
-- LUU DUNG DON VI MA COT DANG HIEN THI (m2/thang, da nhan 30), khong luu m2/ngay:
-- muc dich cua cot la doc cho nhanh, nen ben doc khong phai nhan them gi.
--
-- Grain: khoa bang la (cn_code, sku_code, period_start) nen gia tri nam rai theo CN.
-- Phep truot tuyen tinh ⇒ SUM qua CN = so toan quoc, chinh xac tuyet doi. F1-B3 doc:
--   SELECT sku_code, SUM(sales_ma_qty) FROM branch_forecast
--    WHERE period_start = date_trunc('month', CURRENT_DATE)::date GROUP BY sku_code
--
-- ⚠ branch_forecast nam trong publication `scp_prod` va publication nay phat TAT CA
--   cac cot (pg_publication_rel.prattrs IS NULL). Them cot o publisher ma subscriber
--   chua co se lam apply worker bao loi va replication dung.
--   → Chay migration nay o SUBSCRIBER TRUOC, publisher sau.

ALTER TABLE public.branch_forecast
  ADD COLUMN IF NOT EXISTS sales_ma_qty numeric(15,2);

COMMENT ON COLUMN public.branch_forecast.sales_ma_qty IS
  'TB truot ban n ngay gan nhat, quy m2/THANG = (SUM m2 trong n ngay / n) * 30. '
  'Cua so tinh toi ngay chay cron, KHONG theo period_start cua dong. '
  'Do app scp-forecast ghi moi 02:00; SCP (F1-B3, cot "TB truot Sales") chi doc.';

-- Lich su: giu du cap old/new nhu cac truong san co.
ALTER TABLE public.branch_forecast_history
  ADD COLUMN IF NOT EXISTS old_sales_ma_qty numeric(15,2);

ALTER TABLE public.branch_forecast_history
  ADD COLUMN IF NOT EXISTS new_sales_ma_qty numeric(15,2);
