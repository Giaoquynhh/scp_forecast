-- MA3 — trung bình trượt 3 tháng của lượng bán thực tế (m²).
--
--   MA3 = (B1 + B2 + B3) / 3
--
-- Dùng đúng 3 khối mà FC đang dùng (3 tháng dương lịch liền trước tháng đích),
-- cùng bộ lọc: chỉ đơn vị m2, chỉ lượng bán ra (quantity > 0).
-- Khác FC ở chỗ MA3 KHÔNG có trọng số và KHÔNG quy theo số ngày của tháng đích.
--
-- ⚠ branch_forecast nằm trong publication `scp_prod` và publication này phát
--   TẤT CẢ các cột (pg_publication_rel.prattrs IS NULL). Thêm cột ở publisher
--   mà subscriber chưa có sẽ làm apply worker báo lỗi và replication đứng.
--   → Chạy migration này ở SUBSCRIBER TRƯỚC, publisher sau.

ALTER TABLE public.branch_forecast
  ADD COLUMN IF NOT EXISTS ma3 numeric(15,2);

COMMENT ON COLUMN public.branch_forecast.ma3 IS
  'Trung bình trượt 3 tháng (m2) = (B1+B2+B3)/3. Do app scp-forecast ghi; SCP chỉ đọc.';

-- Lịch sử: giữ đủ cặp old/new như các trường sẵn có.
ALTER TABLE public.branch_forecast_history
  ADD COLUMN IF NOT EXISTS old_ma3 numeric(15,2);

ALTER TABLE public.branch_forecast_history
  ADD COLUMN IF NOT EXISTS new_ma3 numeric(15,2);
