-- Accuracy FC vs MA3 tính sẵn, để màn "Độ tin cậy" (F1-B1) chỉ SELECT.
--
-- Hai grain, cùng một bộ cấu phần mà forecast-learning.service.ts của SCP đang cộng:
--   forecast_accuracy_sku  CN × SKU × tháng  — mỗi dòng ứng đúng 1 dòng branch_forecast
--   forecast_accuracy_cn   CN × tháng        — gộp từ bảng sku ở trên
--
-- Lưu CẤU PHẦN chứ không chỉ %: cột Tổng kết / Kết luận / KPI phụ thuộc khoảng tháng
-- khách chọn (3/5/7…), nên BE cộng cấu phần của khoảng đó rồi chia một lần.
--
-- Tập chấm (scored) giống hằng SCORED bên SCP: có actual_qty VÀ có fc_qty VÀ có ma3.
-- `closed` = tháng đã khép lúc tính (tháng < tháng hiện tại) ⇒ mới có %; tháng đang
-- chạy và tháng sau vẫn có dòng (cấu phần + số lượng) nhưng acc_* để NULL.
--
-- KHÔNG thêm vào publication scp_prod (publication liệt kê từng bảng) — bảng này
-- tính lại được bất cứ lúc nào từ branch_forecast.

CREATE TABLE IF NOT EXISTS public.forecast_accuracy_sku (
  cn_code        varchar(20)  NOT NULL,
  sku_code       varchar(50)  NOT NULL,
  period_start   date         NOT NULL,
  scored         boolean      NOT NULL,
  closed         boolean      NOT NULL,
  -- Cấu phần trên tập scored (NULL khi ô không được chấm)
  tt             numeric(15,2),
  fc             numeric(15,2),
  ma3            numeric(15,2),
  abs_err_fc     numeric(15,2),
  abs_err_ma3    numeric(15,2),
  -- Số lượng thô, không lọc scored — cho tháng sau (chưa có TT)
  fc_raw         numeric(15,2),
  ma3_raw        numeric(15,2),
  -- 0..100, chỉ có khi scored AND closed. Grain một ô: khớp tổng = từng mã.
  acc_fc         double precision,
  acc_ma3        double precision,
  computed_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (period_start, cn_code, sku_code)
);

CREATE INDEX IF NOT EXISTS forecast_accuracy_sku_cn_idx
  ON public.forecast_accuracy_sku (cn_code, period_start);

CREATE TABLE IF NOT EXISTS public.forecast_accuracy_cn (
  cn_code        varchar(20)  NOT NULL,
  period_start   date         NOT NULL,
  closed         boolean      NOT NULL,
  sku_count      integer      NOT NULL,
  scored_count   integer      NOT NULL,
  -- Cấu phần: Σ trên các ô scored của CN × tháng
  tt             numeric(18,2),
  fc             numeric(18,2),
  ma3            numeric(18,2),
  abs_err_fc     numeric(18,2),
  abs_err_ma3    numeric(18,2),
  fc_raw         numeric(18,2),
  ma3_raw        numeric(18,2),
  -- Mức khớp TỔNG: 1 − |Σfc − Σtt| / Σtt   (lệch ròng trong CN × tháng)
  acc_fc         double precision,
  acc_ma3        double precision,
  -- Độ đúng TỪNG MÃ (WAPE): 1 − Σ|tt − fc| / Σtt
  sku_acc_fc     double precision,
  sku_acc_ma3    double precision,
  computed_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (period_start, cn_code)
);
