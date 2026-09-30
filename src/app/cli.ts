import { CFG } from '../config.js';
import { describeFcDaySpec } from '../domain/period.js';
import type { RunMode } from './runner.js';

export interface CliArgs {
  month?: string;
  only: RunMode;
  dryRun: boolean;
  daemon: boolean;
  migrate: boolean;
  ttMonths: number;
  limit?: number;
  /** true = chạy HTTP server đọc-thuần thay vì tính một lượt. */
  serve: boolean;
  port: number;
  /** true = chỉ dựng bảng forecast_accuracy_*, không tính TT/FC. */
  accuracy: boolean;
  /** --accuracy: tháng đầu (YYYY-MM). Bỏ trống = 13 tháng gần nhất + tháng sau. */
  from?: string;
  /** --accuracy: tháng cuối (YYYY-MM). Mặc định tháng sau. */
  to?: string;
  /** --accuracy: dựng lại cả tháng không cũ. */
  force: boolean;
}

/** Phân tích tham số dòng lệnh. Hàm thuần — test được, không đụng process.argv. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    only: 'both', dryRun: false, daemon: false, migrate: false, ttMonths: CFG.ttMonths,
    serve: false, port: CFG.httpPort, accuracy: false, force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${token} cần một giá trị`);
      i += 1;
      return v;
    };
    const inline = (prefix: string) => token.slice(prefix.length);

    if (token === '--month') args.month = value();
    else if (token.startsWith('--month=')) args.month = inline('--month=');
    else if (token === '--only') args.only = value() as CliArgs['only'];
    else if (token.startsWith('--only=')) args.only = inline('--only=') as CliArgs['only'];
    else if (token === '--tt-months') args.ttMonths = Number(value());
    else if (token.startsWith('--tt-months=')) args.ttMonths = Number(inline('--tt-months='));
    else if (token === '--limit') args.limit = Number(value());
    else if (token.startsWith('--limit=')) args.limit = Number(inline('--limit='));
    else if (token === '--port') args.port = Number(value());
    else if (token.startsWith('--port=')) args.port = Number(inline('--port='));
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--daemon') args.daemon = true;
    else if (token === '--serve') args.serve = true;
    else if (token === '--migrate') args.migrate = true;
    else if (token === '--accuracy') args.accuracy = true;
    else if (token === '--force') args.force = true;
    else if (token === '--from') args.from = value();
    else if (token.startsWith('--from=')) args.from = inline('--from=');
    else if (token === '--to') args.to = value();
    else if (token.startsWith('--to=')) args.to = inline('--to=');
    else if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    else throw new Error(`Tham số lạ: ${token}`);
  }

  if (!['fc', 'tt', 'both', 'ma3', 'tt-fill', 'tt-close', 'sales-ma'].includes(args.only)) {
    throw new Error(
      '--only phải là fc | tt | both | ma3 | tt-fill | tt-close | sales-ma' +
      ` (nhận được: ${args.only})`,
    );
  }
  if (!Number.isInteger(args.ttMonths) || args.ttMonths < 1) {
    throw new Error('--tt-months phải là số nguyên >= 1');
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('--limit phải là số nguyên >= 1');
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error('--port phải là số nguyên trong khoảng 1..65535');
  }
  for (const [flag, v] of [['--from', args.from], ['--to', args.to]] as const) {
    if (v !== undefined && !/^\d{4}-\d{2}$/.test(v)) throw new Error(`${flag} phải là YYYY-MM (nhận được: ${v})`);
  }
  if ((args.from || args.to || args.force) && !args.accuracy) {
    throw new Error('--from / --to / --force chỉ dùng cùng --accuracy');
  }
  if (args.serve && args.daemon) {
    throw new Error('--serve và --daemon loại trừ nhau: một tiến trình chỉ làm một việc');
  }
  return args;
}

export function printUsage(): void {
  console.log(`
scp-forecast — tính TT, FC và MA3 rồi ghi vào branch_forecast

  npm run migrate                 thêm cột mà app cần (ma3) vào DB
  npm run cron                    chạy nền, cron ${CFG.cronSchedule} (${CFG.timezone})
                                  FC: ${describeFcDaySpec(CFG.fcDay)} → tháng ${CFG.fcTarget === 'next' ? 'sau' : 'hiện tại'}
  npm start                       một lượt: FC cho tháng ${CFG.fcTarget === 'next' ? 'SAU' : 'hiện tại'}, TT cho tháng hiện tại
  npm start -- --month 2026-09    chạy cho tháng chỉ định (cả FC lẫn TT)
  npm start -- --only fc          chỉ tính FC + MA3
  npm start -- --only tt          chỉ tính TT
  npm start -- --month 2026-03 --only ma3
  npm start -- --month 2026-03 --only tt-fill    lấp TT vào ô còn TRỐNG mà tháng đó CÓ bán
                                  thuần bổ sung: không ghi đè số nào, không tạo ô TT=0
  npm start -- --month 2026-03 --only tt-close   đóng sổ TT=0 cho dòng có dự báo mà bán 0
                                  hạ accuracy toàn hệ thống — quyết định vận hành
                                  điền bù MA3 vào tháng cũ — chỉ sửa dòng đã có,
                                  KHÔNG đụng fc_qty, KHÔNG thêm dòng mới
  npm start -- --only sales-ma    CHỈ tính lại TB trượt bán n ngày (cột sales_ma_qty)
                                  n đọc từ system_config planning.ma_months (mặc định 90)
                                  F1-B3 bên SCP đọc thẳng cột này; lượt 'both'/'tt'
                                  cũng đã tính nó rồi, mode này để chạy lại riêng
  npm start -- --dry-run          tính và in kết quả, KHÔNG ghi DB
  npm start -- --tt-months 2      số tháng gần nhất được tính lại TT
  npm start -- --limit 20         chỉ ghi N dòng đầu (để thử)

  npm run acc                     dựng bảng forecast_accuracy_sku / _cn cho các tháng CŨ
                                  (13 tháng gần nhất + tháng sau). Cron đã tự chạy sau mỗi lượt.
  npm run acc -- --from 2026-01 --force   tính bù / dựng lại toàn bộ từ tháng chỉ định
  npm run acc -- --dry-run        chỉ liệt kê tháng sẽ tính lại

  npm run serve                   HTTP đọc-thuần trên ${CFG.httpHost}:${CFG.httpPort}
  npm run serve -- --port 4000    đổi cổng
      GET /demand/summary?from=YYYY-MM&to=YYYY-MM&groupBy=cn|month|cn-month|none
                                  tổng FC / MA3 / TT. Không có auth — chỉ nghe localhost.
`);
}
