# scp-forecast — danh sách endpoint

App này chủ yếu là CLI + cron; phần HTTP chỉ có **2 endpoint đọc-thuần**, không
ghi gì vào DB.

```bash
npm run serve                    # nghe 127.0.0.1:3010
npm run serve -- --port 4000     # đổi cổng
```

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | [`/health`](#get-health) | Kiểm tra tiến trình còn sống |
| GET | [`/demand/summary`](#get-demandsummary) | Tổng lượng gạch: FC / MA3 / Thực tế |

**Base URL** `http://127.0.0.1:3010` — không có tiền tố `/api/v1` như SCP.

> ⚠ **Không có auth/RBAC.** Mặc định chỉ nghe `127.0.0.1`. Đổi `HTTP_HOST` là ai
> trong mạng cũng đọc được số bán của toàn bộ chi nhánh. Muốn đưa ra ngoài thì
> đặt sau reverse proxy có xác thực.

Chỉ nhận `GET`. Method khác trả `405`.

---

## GET /health

Không tham số. Dùng cho healthcheck của process manager — **không** chạm DB, nên
nó `ok` không có nghĩa là Postgres còn sống.

```json
{ "ok": true }
```

---

## GET /demand/summary

Cộng `branch_forecast` trong Postgres rồi trả về tổng, thay vì để phía gọi kéo cả
grid về tự cộng. Cả năm 2026 gộp theo (CN × tháng) — 82.921 dòng — ra 487 dòng /
138 KB trong 0,6 giây.

Ba con số đọc **thẳng** từ bảng, không tính lại: `fc_qty` và `ma3` do lượt sinh FC
ghi, `actual_qty` do lượt tính TT ghi.

### Tham số

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `from` | tháng hiện tại | `YYYY-MM`, bao gồm |
| `to` | `= from` | `YYYY-MM`, bao gồm |
| `groupBy` | `cn` | `cn` · `month` · `cn-month` · `none` |
| `cnCode` | — | Lọc mã CN, ngăn bằng phẩy: `049,050` |
| `skuCode` | — | Lọc mã SKU gốc (`sku.sku_code`), ngăn bằng phẩy |
| `hideInactiveSku` | `true` | Ẩn SKU Ngừng (`sku.active = false`). Khớp mặc định của `grid/cn` bên SCP |
| `rounded` | `false` | `true` = đọc cột `fc_qty_rounded` / `actual_qty_rounded` (đã làm tròn hàng trăm) |

`groupBy=none` trả `rows: []`, chỉ có `total` — dùng khi chỉ cần một con số.

Tham số boolean chỉ tắt khi nhận `0` hoặc `false`; giá trị lạ giữ mặc định. Tháng
sai định dạng hoặc `groupBy` lạ thì trả `400` chứ không lặng lẽ về mặc định.

### Trường của mỗi dòng

Cùng một hình dạng cho cả `rows[]` và `total`.

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `cnCode` `cnName` `region` | `string\|null` | `null` khi `groupBy` không chia theo CN |
| `month` | `string\|null` | `YYYY-MM`; `null` khi không chia theo tháng |
| `fcQty` | `number\|null` | Σ `fc_qty` |
| `ma3Qty` | `number\|null` | Σ `ma3` |
| `actualQty` | `number\|null` | Σ `actual_qty` |
| `gapQty` | `number\|null` | `fcQty − actualQty`. Dương = dự báo cao hơn thực bán |
| `gapPct` | `number\|null` | `gapQty / actualQty × 100` |
| `fcWmapePct` | `number\|null` | `Σ\|fc − actual\| / Σactual × 100` |
| `ma3WmapePct` | `number\|null` | Cùng công thức cho MA3 |
| `rowCount` | `number` | Số dòng (cn × sku × tháng) gộp vào nhóm |
| `skuCount` `cnCount` | `number` | Đếm **phân biệt** |
| `ma3RowCount` | `number` | Số dòng thực có `ma3` |
| `comparableRowCount` | `number` | Số dòng có đủ cả `fc` và `actual` |

Mọi số lượng làm tròn 2 chữ số, khớp `numeric(15,2)` của cột nguồn.

### Ba điều dễ đọc sai

**`null` không phải `0`.** `actualQty: null` là *tháng chưa có TT*, không phải bán
được 0 — nên `gapQty` và WMAPE cũng `null`. `ma3Qty: null` là *chưa có MA3*, gặp ở
những dòng do FC engine cũ bên SCP ghi.

**Hai WMAPE có mẫu số riêng.** Chỉ cộng trên dòng có đủ cả hai số. Dùng chung
`actualQty` tổng sẽ làm sai số nhìn nhỏ đi một cách giả tạo. Vì vậy
`ma3WmapePct` có thể `null` trong khi `ma3RowCount > 0`: MA3 có, nhưng những dòng
đó chưa có TT để so.

**WMAPE khác `|gapPct|`.** WMAPE cộng trị tuyệt đối từng dòng, nên **sai số thừa
của SKU này không bù trừ sai số thiếu của SKU kia**. Tổng có thể khớp hoàn hảo
trong khi từng SKU sai bét. Dữ liệu thật tháng 6/2026: `gapPct` −53,56% mà
`fcWmapePct` 105,73%.

**`total` không phải tổng của `rows`.** Nó là tổng của *toàn bộ khoảng lọc*, gom
bằng một lượt `GROUP BY` rỗng riêng — vì `skuCount`/`cnCount` là đếm phân biệt,
cộng dồn từ các nhóm con sẽ sai (một SKU bán ở 5 CN vẫn là 1 SKU).

### Ví dụ

```bash
curl "http://127.0.0.1:3010/demand/summary?from=2026-08&to=2026-09&groupBy=cn&cnCode=049,050"
```

```json
{
  "data": {
    "from": "2026-08",
    "to": "2026-09",
    "groupBy": "cn",
    "rounded": false,
    "rows": [
      {
        "cnCode": "049",
        "cnName": "Chi nhánh Khánh Hòa Unis",
        "region": "MT-TNG",
        "month": null,
        "fcQty": 25167.81,
        "ma3Qty": 17850.38,
        "actualQty": 15489.72,
        "gapQty": 9678.09,
        "gapPct": 62.48,
        "fcWmapePct": 111.93,
        "ma3WmapePct": null,
        "rowCount": 463,
        "skuCount": 245,
        "cnCount": 1,
        "ma3RowCount": 212,
        "comparableRowCount": 204
      }
    ],
    "total": {
      "cnCode": null, "cnName": null, "region": null, "month": null,
      "fcQty": 46375.77, "ma3Qty": 31337.84, "actualQty": 23588.44,
      "gapQty": 22787.33, "gapPct": 96.6,
      "fcWmapePct": 122.55, "ma3WmapePct": null,
      "rowCount": 1076, "skuCount": 566, "cnCount": 2,
      "ma3RowCount": 464, "comparableRowCount": 470
    }
  }
}
```

Một con số cho cả hệ thống, không lọc SKU Ngừng — dùng để đối chiếu với số ghi
trong README:

```bash
curl "http://127.0.0.1:3010/demand/summary?from=2026-09&groupBy=none&hideInactiveSku=0"
# fcQty 453275.52   ma3Qty 529381.12
```

Theo tháng, để xem FC bám sát tới đâu qua thời gian:

```bash
curl "http://127.0.0.1:3010/demand/summary?from=2026-06&to=2026-09&groupBy=month"
```

| month | fcQty | ma3Qty | actualQty | fcWmapePct |
|---|---|---|---|---|
| 2026-06 | 273.537,10 | `null` | 589.069,42 | 105,73 |
| 2026-07 | 274.387,16 | `null` | 584.461,80 | 107,63 |
| 2026-08 | 274.185,58 | `null` | 346.727,11 | 133,74 |
| 2026-09 | 447.299,08 | 522.550,17 | `null` | `null` |

`ma3Qty` chỉ có ở 2026-09 vì các tháng trước do FC engine cũ bên SCP ghi, chưa có
MA3.

---

## Lỗi

Mọi lỗi trả cùng một hình dạng:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "..." } }
```

| HTTP | `code` | Khi nào |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Tháng sai định dạng, `to < from`, `groupBy` lạ |
| 404 | `NOT_FOUND` | Đường dẫn không có |
| 405 | `METHOD_NOT_ALLOWED` | Không phải `GET` |
| 500 | `INTERNAL_ERROR` | DB sập, hoặc cột `ma3` chưa chạy `npm run migrate` |

Ví dụ thật:

```
?from=2026-9              → 400  from phải có dạng YYYY-MM (nhận được: 2026-9)
?from=2026-09&to=2026-08  → 400  to (2026-08) không được nhỏ hơn from (2026-09)
?groupBy=sku             → 400  groupBy phải là cn | month | cn-month | none (nhận được: sku)
```

`message` là chuỗi cho người đọc, có thể đổi giữa các bản — đừng bắt theo nó, bắt
theo `code`.

---

## Endpoint bên SCP đọc cùng bảng

Tham khảo, **không thuộc app này** — nằm ở `SmartlogSCP.Backend`, base URL
`/api/v1`, có auth + RBAC riêng.

| Endpoint | Có gì | Thiếu gì |
|---|---|---|
| `GET /demand/grid/total` | `summary.months[] = { fc, actualQty }` theo 12 tháng | Không tách theo CN, không có MA3 |
| `GET /demand/grid/cn` | Grid CN × SKU × tháng, từng ô `{ fc, actualQty, accuracyPct }` | **Không có khối `summary`** — payload ~12 MB, FE phải tự cộng |
| `GET /demand/kpi` | KPI dashboard | Đọc `demand_snapshot_line`, không phải `branch_forecast`. Không có tổng lượng |
| `GET /demand/accuracy/*` | Có `ma3_mape` | Là chỉ số của bảng `demand_accuracy`, **không phải** cột `ma3` ở `branch_forecast` |

Cột `ma3` mà app này ghi **chưa được khai** trong
`SmartlogSCP.Backend/src/demand/entities/branch-forecast.entity.ts`, nên không
endpoint nào bên SCP đọc được nó.

Cả 13 endpoint `/demand/*` của F1-B1 đang bị `F1B1PausedGuard` chặn — trả `503`
trước khi chạm DB, mặc định là DỪNG (thiếu env cũng dừng). Bật lại bằng
`F1B1_PAUSED=false`. Lý do tạm dừng ghi trong `f1b1-paused.ts`: `grid/cn` trả
12 MB gây timeout kéo theo cả màn khác.
