# scp-forecast

App độc lập tính **TT** (lượng bán thực tế) và **FC** (dự báo) rồi ghi thẳng vào
bảng `branch_forecast` của DB SCP.

```
scp-forecast  ──ghi──►  branch_forecast  ◄──đọc──  SCP F1-B1 (màn Nhu cầu)
```

Hai bên **không gọi API của nhau** — DB là điểm tích hợp duy nhất. SCP chỉ SELECT.

---

## Chạy

```bash
npm install
cp .env.example .env      # điền DB_PASSWORD
npm run migrate                 # thêm cột ma3 vào DB (chạy một lần)

npm run cron                    # chạy nền theo lịch 02:00 mỗi ngày  ← cách dùng chính
npm start                       # chạy một lượt cho tháng hiện tại
npm start -- --month 2026-09    # chạy cho tháng chỉ định
npm start -- --only fc          # chỉ FC
npm start -- --only tt          # chỉ TT
npm start -- --dry-run          # tính và in ra, KHÔNG ghi DB
npm start -- --limit 20         # chỉ ghi 20 dòng đầu, để thử
```

---

## Lịch chạy

`npm run cron` giữ tiến trình sống và tự chạy **02:00 mỗi ngày** (giờ VN):

| Ngày | Việc |
|---|---|
| Ngày thường | Tính lại **TT của tháng hiện tại** |
| **Mùng 1** | Chốt sổ TT tháng trước lần cuối → tính lại TT tháng mới → sinh **FC** cho tháng mới |

Mỗi lượt là **tính lại tổng lũy kế** từ `sales_transaction_v2`, không phải cộng
dồn — nên phần dữ liệu bán mới đổ về từ hôm trước tự động được tính vào. Ví dụ
TT đang là tổng của ngày 1–15; 02:00 ngày 17 chạy lại thì ra tổng ngày 1–16.

Lượt trước chưa xong thì lượt sau **bỏ qua**, tránh hai tiến trình cùng ghi. Lỗi
trong một lượt được ghi log và daemon vẫn sống, lượt sau thử lại.

Thử lịch mà không đụng DB:

```bash
CRON_SCHEDULE="* * * * *" npm start -- --daemon --dry-run
```

### Chạy như dịch vụ Windows

Daemon phải luôn bật thì cron mới nổ. Nếu không muốn giữ cửa sổ terminal, dùng
Task Scheduler gọi thẳng lệnh một lượt, mỗi ngày 02:00:

```
Program:    C:\Program Files\nodejs\npm.cmd
Arguments:  start
Start in:   D:\SCP\forecast
```

Cách này không cần daemon, nhưng phải tự thêm điều kiện FC — hoặc để nguyên
`npm start` (chạy cả TT lẫn FC mỗi ngày) và đặt `FC_RECOMPUTE_DAILY=true`.

---

## Công thức FC

App chạy vào **mùng 1 của tháng đích T**, lấy dữ liệu bán của **3 tháng dương
lịch liền trước** — lúc đó cả 3 tháng đều đã đóng sổ nên không bị hụt ngày.

```
T = tháng 3  →  B1 = tháng 2   (trọng số 0.6)
                B2 = tháng 1   (trọng số 0.3)
                B3 = tháng 12  (trọng số 0.1)

weighted = 0.6·B1 + 0.3·B2 + 0.1·B3
perDay   = weighted / 30
FC       = perDay × số ngày của tháng T
```

Ví dụ một cặp (CN Hà Nội × SKU X) bán B1 = 310, B2 = 300, B3 = 150 m², tính cho
tháng 8 (31 ngày):

```
weighted = 0.6·310 + 0.3·300 + 0.1·150 = 186 + 90 + 15 = 291 m²
perDay   = 291 / 30                                     = 9,7 m²/ngày
FC       = 9,7 × 31                                     = 300,7 m²
```

**Mẫu số luôn là 30**, kể cả khi khối là tháng 28 hay 31 ngày — đây là quy ước
của công thức nghiệp vụ, không phải số ngày thật của khối.

---

## Kết nối DB và SSL

| `DB_SSL` | Nghĩa | Dùng khi |
|---|---|---|
| `disable` *(mặc định)* | Không mã hóa | DB chạy trên chính máy này |
| `require` | Có mã hóa, **không** kiểm chứng certificate | Mạng nội bộ tin được. Chặn được nghe lén nhưng không chặn được kẻ đứng giữa giả danh server |
| `verify-full` | Mã hóa + kiểm chứng certificate và tên host. Cần `DB_SSL_CA` | **Bất cứ khi nào đi qua Internet** |

Mỗi lượt chạy in ra trạng thái thật của kết nối, lấy từ `pg_stat_ssl` — không phải
đọc config mà đoán:

```
DB    postgres@localhost:5432/test_scp  ·  không mã hóa
DB    sahuslab@103.78.3.103:5433/unis_scp_main2  ·  SSL TLSv1.3 · TLS_AES_256_GCM_SHA384
```

> ⚠ **Postgres local đang có `ssl = off`** nên không mã hóa được, kể cả đặt
> `DB_SSL=require` (server sẽ từ chối: *"The server does not support SSL
> connections"*). Chỉ có ý nghĩa khi trỏ sang VPS — và lúc đó **phải dùng
> `verify-full`**, vì `require` không chặn được tấn công người-đứng-giữa: kẻ tấn
> công dựng server giả vẫn lấy được mật khẩu DB.

Muốn bật SSL cho Postgres local: đặt `ssl = on` trong `postgresql.conf`, khai
`ssl_cert_file` / `ssl_key_file`, rồi restart service.

---

## MA3 — trung bình trượt 3 tháng

Cột `branch_forecast.ma3`, do app này ghi cùng lúc với FC:

```
MA3 = (B1 + B2 + B3) / 3
```

Dùng **đúng 3 khối mà FC dùng** và cùng bộ lọc (chỉ m², chỉ lượng bán ra). Khác
FC ở hai chỗ: **không có trọng số** và **không quy theo số ngày** của tháng đích.
Cùng ví dụ trên (B1 = 310, B2 = 300, B3 = 150):

```
FC  = (0.6·310 + 0.3·300 + 0.1·150) / 30 × 31 = 300,7 m²   ← ưu tiên tháng gần
MA3 = (310 + 300 + 150) / 3                   = 253,3 m²   ← cào bằng 3 tháng
```

Đo trên dữ liệu thật cho tháng 9/2026: FC 453.275 m², MA3 529.381 m² — MA3 cao
hơn vì tháng xa (B3) được tính ngang tháng gần, mà tháng 6 bán nhiều hơn tháng 8.

### Cột đã thêm vào DB

| Bảng | Cột | Kiểu |
|---|---|---|
| `branch_forecast` | `ma3` | `numeric(15,2)` NULL |
| `branch_forecast_history` | `old_ma3`, `new_ma3` | `numeric(15,2)` NULL |

Chạy bằng `npm run migrate` — file trong `migrations/`, đã chạy thì lần sau bỏ
qua (ghi vết ở bảng `forecast_app_migration`).

> ⚠ `branch_forecast` nằm trong publication `scp_prod` và publication này phát
> **tất cả các cột**. Thêm cột ở publisher mà subscriber chưa có sẽ làm
> replication đứng. **Chạy migration ở subscriber trước, publisher sau.**

Muốn SCP hiển thị MA3 thì phải khai thêm cột vào entity
`SmartlogSCP.Backend/src/demand/entities/branch-forecast.entity.ts` — app này
không đụng tới code SCP.

### Đổi sang cửa sổ 30 ngày trượt

Đặt `FC_BLOCK_MODE=rolling` trong `.env` thì B1/B2/B3 thành 3 cửa sổ 30 ngày đếm
ngược từ ngày đầu tháng đích (T = 01/09 → B1 = 02/08–01/09). Chênh lệch thực đo
trên dữ liệu tháng 9/2026: `calendar` 453.275 m² và `rolling` 437.804 m².

---

## Nguồn dữ liệu

Cả TT lẫn FC đều đọc từ **`f2_supply.sales_transaction_v2`** (2,24 triệu dòng,
từ 2017), giữ nguyên bộ quy tắc đã chốt với nghiệp vụ bên SCP:

- map `item_code = sku.bravo_sku` → gộp theo `sku.sku_code` (SKU gốc master data)
- chỉ đơn vị **m2**, bỏ Kg và các đơn vị khác
- **chỉ cộng lượng bán ra** (`quantity > 0`). Dòng trả hàng mang số âm bị **loại
  hẳn**, không trừ vào tổng
- `cn_code` phải có trong bảng `channel`

**Cặp CN × SKU không bán gì trong 3 khối thì không tạo dòng mới.** Dòng đã có sẵn
trong `branch_forecast` vẫn được cập nhật bình thường.

### TT của tháng đã qua thì đóng băng

Mỗi lượt cron chỉ tính lại TT của **tháng hiện tại** (`TT_MONTHS=1`). Tháng đã
qua coi như chốt sổ — dữ liệu bán của nó có sửa về sau cũng **không cập nhật lại
nữa**. Đang là tháng 3 mà ai đó sửa số bán tháng 2 thì kệ, TT tháng 2 giữ nguyên.

Ngoại lệ duy nhất: **mùng 1**, tháng liền trước được tính lại đúng một lần để chốt
sổ, rồi khóa luôn. Không có bước này thì tháng 2 vĩnh viễn thiếu ngày cuối — 02:00
ngày 28 mới cộng tới ngày 27 — mà FC tháng 3 lại lấy tháng 2 làm B1. Tắt bằng
`TT_CLOSEOUT_PREV_MONTH=false`.

TT của tháng hiện tại chỉ cộng tới hôm nay (`doc_date <= CURRENT_DATE`). Dòng có
TT cũ nhưng kỳ này không còn phát sinh bán sẽ được đưa về 0 thay vì để số cũ nằm lại.

---

## Cách ghi vào DB

Upsert theo khóa `(cn_code, sku_code, period_start)`, đúng hợp đồng mà SCP đang
dùng ở `ForecastService.upsert()` để lịch sử liền mạch:

| Việc | Chi tiết |
|---|---|
| Cột được ghi | `fc_qty`, `actual_qty`, `ma3` |
| Upsert | `ON CONFLICT (cn_code, sku_code, period_start) DO UPDATE` |
| Giữ cột không truyền | `COALESCE` — chạy `--only fc` không xóa mất TT và ngược lại |
| Lịch sử | Ghi `branch_forecast_history` kèm `changed_fields`, `reason` |
| Version | `version = version + 1` mỗi lần thực sự đổi giá trị |
| Bỏ qua dòng không đổi | Giá trị y hệt thì không đụng tới, không đẻ bản ghi lịch sử |
| Cột GENERATED | `fc_qty_rounded` / `actual_qty_rounded` do Postgres tự tính |
| Transaction | Mỗi lô 500 dòng một transaction |

Chạy lại bao nhiêu lần cũng ra cùng kết quả (**idempotent**) — lần thứ hai báo
`thêm 0 · sửa 0 · giữ nguyên N`.

`source` giữ nguyên 2 giá trị SCP đang dùng (`FORECAST_ENGINE` cho FC,
`SALES_V2_BACKFILL` cho TT) để mọi bộ lọc/thống kê sẵn có bên F1-B1 không phải
sửa. Dấu vết của app nằm ở `last_updated_by = forecast-app`.

---

## ⚠ Trước khi cho chạy thật: tắt đường ghi bên SCP

Nếu cả hai bên cùng ghi thì `version` và lịch sử sẽ loạn. Bên
`SmartlogSCP.Backend` còn 3 đường ghi vào `branch_forecast`:

| Đường ghi | Vị trí |
|---|---|
| Cron sinh FC — 03:00 hằng ngày | `src/demand/fc-engine.cron.ts:28` |
| Cron tính lại TT — mỗi 2 giờ | `src/demand/tt-recompute.cron.ts:29` |
| `upsert()` từ wizard Tải lên Forecast (M11) | `src/demand/forecast.service.ts:126` |
| `UPDATE branch_forecast` của FC engine | `src/demand/fc-engine.repository.ts:141` |

Hai cron là thứ đáng lo nhất vì chúng tự chạy ngầm.

---

## Cấu trúc

Ba tầng, phụ thuộc chỉ đi một chiều **app → domain** và **app → infra**.
Tầng `domain` không import gì từ hai tầng kia.

```
src/
  domain/                    nghiệp vụ thuần — không có SQL, không import pg
    forecast-formula.ts        weighted / perDay / FC / MA3
    period.ts                  tháng đích T và 3 khối B1/B2/B3
    types.ts                   kiểu dữ liệu + interface SalesReader, ForecastWriter

  infra/                     nói chuyện với Postgres — không có công thức
    db.ts                      connection pool
    sales.repository.ts        SalesRepository   (đọc sales_transaction_v2)
    branch-forecast.repository.ts
                               BranchForecastRepository (upsert + lịch sử + version)
    migrator.ts                chạy các file trong migrations/

  app/                       điều phối
    forecast.service.ts        ForecastService — gọi reader, áp công thức, gọi writer
    runner.ts                  một lượt tính + ghi, phần in ra màn hình
    container.ts               composition root: chỗ DUY NHẤT ghép các tầng
    scheduler.ts               daemon cron
    cli.ts                     phân tích tham số dòng lệnh

  config.ts                  đọc .env
  index.ts                   điểm vào, chỉ định tuyến

tests/                       chạy bằng `npm test`, KHÔNG cần DB
```

**Vì sao chia thế này.** Bản đầu nhét cả công thức lẫn SQL vào một file: quy tắc
nghiệp vụ `round(weighted / 30 * days, 2)` nằm trong chuỗi SQL nên muốn kiểm
chứng phải dựng DB, và đổi tên bảng phải sửa cùng file với đổi công thức. Sau khi
tách, công thức là hàm thuần test được bằng số liệu tay, còn `ForecastService`
phụ thuộc **interface** `SalesReader` / `ForecastWriter` chứ không phụ thuộc
Postgres — nên test service chỉ cần object giả.

Class chỉ dùng ở chỗ **thật sự giữ state**: hai repository giữ connection pool,
service giữ dependency. Công thức và xử lý ngày tháng vẫn là hàm thuần — bọc
chúng vào class chỉ làm code dài ra mà không được gì.

**Lưu ý:** công thức chạy bằng số dấu phẩy động của JS thay vì `numeric` của
Postgres. Mỗi dòng vẫn làm tròn 2 chữ số; tổng của 9.517 dòng lệch khoảng 1 m²
(0,0002%) so với bản tính trong SQL.

```bash
npm test        # 15 test, ~0,3 giây, không cần DB
npm run typecheck
```

Đổi bằng `.env`, không cần sửa code:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `FC_WEIGHT_B1/B2/B3` | 0.6 / 0.3 / 0.1 | Trọng số 3 khối |
| `FC_PER_DAY_DIVISOR` | 30 | Mẫu số của bước perDay |
| `FC_BLOCK_MODE` | calendar | `calendar` hoặc `rolling` |
| `TT_MONTHS` | 1 | Số tháng gần nhất tính lại TT |
| `TT_CLOSEOUT_PREV_MONTH` | true | Chốt sổ tháng trước vào mùng 1 |
| `CRON_SCHEDULE` | `0 2 * * *` | Lịch chạy daemon |
| `FC_DAY_OF_MONTH` | 1 | Ngày sinh FC |
| `FC_RECOMPUTE_DAILY` | false | true = tính lại FC mỗi ngày |
