# Hướng dẫn cài cron dự báo (scp-forecast) trên VPS

## 1. Yêu cầu nghiệp vụ

Cron chạy **02:00 giờ Việt Nam mỗi ngày**. Mỗi lượt làm việc khác nhau tuỳ ngày:

| Thời điểm | Việc phải xảy ra |
|---|---|
| 02:00 **ngày cuối tháng** (31/08, 30/09, 28/02…) | Tính **FC + MA3 cho tháng sau** (số xem trước) |
| 02:00 **mùng 1** | Tính lại FC của tháng vừa bắt đầu (số chốt), chốt TT tháng trước |
| 02:00 các ngày còn lại | Chỉ tính TT tháng hiện tại và `sales_ma_qty` |

Ví dụ: 02:00 ngày 30/09 tính FC tháng 10, rồi 02:00 ngày 01/10 tính lại FC tháng 10 để chốt.

## 2. Vấn đề đang gặp (tính đến 30/09/2026)

Trên DB `unis_scp_main2`, cron hiện tại đang chạy **lệch lịch**:

- 02:00 ngày **02/09** nó sinh FC tháng 10. Lúc đó tháng 9 mới có khoảng 1 ngày bán, nên tổng FC tháng 10 chỉ còn 207.854 m², trong khi tháng 9 là 496.068 m².
- 02:00 ngày **30/09** nó không tính FC, chỉ tính TT.

Hai lỗi này khớp với việc tiến trình đang chạy bằng **giờ UTC**, và/hoặc đang chạy **code hoặc `.env` bản cũ** (`FC_DAY_OF_MONTH=1`).

Vì sao giờ UTC gây lệch: `CRON_SCHEDULE` bấm giờ theo `TZ_NAME` nên vẫn nổ lúc 02:00 VN. Nhưng khâu xét "hôm nay là ngày mấy" lại đọc theo múi giờ của tiến trình Node. 02:00 VN là 19:00 UTC **hôm trước**, nên:

- 02:00 ngày 30/09 VN bị hiểu thành ngày 29, không phải cuối tháng, nên bỏ qua FC.
- 02:00 ngày 02/09 VN bị hiểu thành mùng 1, nên (với config cũ) sinh FC cho tháng sau.

**Cách sửa:** bản code mới (`src/config.ts`) tự ép múi giờ tiến trình theo `TZ_NAME`, nên chỉ cần deploy code mới là hết lệch, dù máy chủ để UTC. Đặt thêm `TZ=Asia/Ho_Chi_Minh` như các lệnh bên dưới vẫn nên làm, nhưng không còn bắt buộc.

## 3. Các bước cài / sửa

### 3.1. Tìm và dừng tiến trình cũ

Trước tiên kiểm tra xem có tiến trình cũ nào đang chạy không. Nếu có hai tiến trình cùng chạy thì chúng sẽ cùng ghi DB, khiến `version` và bảng lịch sử bị rối.

```bash
ps aux | grep -E "index.ts --daemon|npm run cron" | grep -v grep
pm2 ls                                      # nếu dùng pm2
systemctl list-units | grep -i forecast     # nếu dùng systemd
crontab -l                                  # nếu có dòng gọi forecast
```

Dừng hoặc xoá tất cả các tiến trình tìm thấy, chỉ để lại **đúng 1 daemon**.

### 3.2. Cập nhật code

```bash
cd /path/to/forecast
git pull            # hoặc chép lại thư mục forecast bản mới nhất
npm ci
npm test            # phải pass hết (hiện 34/34 ở tests/schedule.test.ts)
```

Cần Node 20 trở lên.

### 3.3. Kiểm `.env`

Các dòng lịch chạy **phải đúng như sau**:

```ini
CRON_SCHEDULE=0 2 * * *
TZ_NAME=Asia/Ho_Chi_Minh
FC_DAY_OF_MONTH=last
FC_TARGET=next
FC_FINALIZE_ON_FIRST=true
FC_RECOMPUTE_DAILY=false
TT_MONTHS=1
TT_CLOSEOUT_PREV_MONTH=true
ACTOR=forecast-app
```

Phần kết nối DB (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`) trỏ tới DB SCP thật. Nếu kết nối qua mạng thì dùng `DB_SSL=verify-full` kèm `DB_SSL_CA`.

Giữ `HTTP_HOST=127.0.0.1`. Endpoint `/demand/summary` không có xác thực, nên đừng mở nó ra ngoài.

### 3.4. Đặt múi giờ và chạy daemon

**Cách A: pm2 (khuyến nghị)**

```bash
cd /path/to/forecast
TZ=Asia/Ho_Chi_Minh pm2 start npm --name scp-forecast -- run cron
pm2 save
pm2 startup        # làm theo lệnh nó in ra để tự chạy khi reboot
```

Nếu tạo lại tiến trình thì phải xoá hẳn rồi start lại, vì pm2 giữ biến môi trường cũ: `pm2 delete scp-forecast` rồi chạy lại lệnh trên.

**Cách B: systemd**

`/etc/systemd/system/scp-forecast.service`:

```ini
[Unit]
Description=scp-forecast daemon
After=network-online.target

[Service]
WorkingDirectory=/path/to/forecast
Environment=TZ=Asia/Ho_Chi_Minh
ExecStart=/usr/bin/npm run cron
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scp-forecast
journalctl -u scp-forecast -f
```

**Không dùng crontab của hệ điều hành** để gọi `npm run fc` / `npm run tt`. Cách đó bỏ mất logic chọn ngày (cuối tháng, mùng 1). Daemon tự lo việc hẹn giờ.

Nếu VPS chạy Windows thì đặt `TZ=Asia/Ho_Chi_Minh` ở biến môi trường của tác vụ, hoặc để múi giờ hệ thống là `SE Asia Standard Time`.

## 4. Kiểm tra sau khi chạy

### 4.1. Log khởi động

Log khởi động phải có đủ các dòng sau:

```
Lịch        0 2 * * *  (Asia/Ho_Chi_Minh)
FC + MA3    ngày cuối tháng → tháng sau
            + mùng 1 chốt lại tháng vừa bắt đầu (B1 đã đủ ngày)
```

Nếu có dòng bắt đầu bằng `⚠ FC_DAY_OF_MONTH=...` thì config đang sai, cần xem lại mục 3.3.

### 4.2. Kiểm múi giờ của tiến trình

```bash
TZ=Asia/Ho_Chi_Minh node -e "const d=new Date();console.log(d.toString(),'ngay=',d.getDate())"
```

Kết quả phải in `GMT+0700` và đúng ngày hôm nay theo giờ VN.

### 4.3. Kiểm DB sau lượt 02:00 ngày cuối tháng

```sql
select period_start, count(*) n, round(sum(fc_qty)) sum_fc, max(last_updated_at) last_upd
from branch_forecast
where period_start >= date_trunc('month', now()) - interval '1 month'
group by 1 order by 1;
```

Dòng của **tháng sau** phải có `last_upd` là 02:00 của hôm nay (ngày cuối tháng). Tổng FC của tháng sau phải cùng cỡ với tháng hiện tại, không hụt một nửa.

## 5. Số FC tháng 10/2026

Số FC tháng 10 hiện đang sai (tính từ 02/09).

**Tự động:** nếu daemon bản mới chạy trước **02:00 ngày 01/10**, lượt chốt mùng 1 sẽ tự tính lại FC + MA3 tháng 10. Không cần làm gì thêm.

**Tính ngay khi deploy** (không muốn chờ tới 02:00), chạy tay một lần:

```bash
cd /path/to/forecast
TZ=Asia/Ho_Chi_Minh npm run fc -- --month 2026-10 --dry-run   # xem số trước, không ghi
TZ=Asia/Ho_Chi_Minh npm run fc -- --month 2026-10             # ghi thật
```

Lượt chốt 02:00 ngày 01/10 sẽ tự tính lại lần nữa khi tháng 9 đã đủ ngày.

## 6. Liên hệ

Nếu có gì chưa rõ về nghiệp vụ hoặc số liệu, liên hệ team SCP (teamai1@gosmartlog.com).
