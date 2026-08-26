import { CFG } from '../config.js';
import { describeFcDaySpec } from '../domain/period.js';

export interface CliArgs {
  month?: string;
  only: 'fc' | 'tt' | 'both';
  dryRun: boolean;
  daemon: boolean;
  migrate: boolean;
  ttMonths: number;
  limit?: number;
  /** true = chạy HTTP server đọc-thuần thay vì tính một lượt. */
  serve: boolean;
  port: number;
}

/** Phân tích tham số dòng lệnh. Hàm thuần — test được, không đụng process.argv. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    only: 'both', dryRun: false, daemon: false, migrate: false, ttMonths: CFG.ttMonths,
    serve: false, port: CFG.httpPort,
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
    else if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    else throw new Error(`Tham số lạ: ${token}`);
  }

  if (!['fc', 'tt', 'both'].includes(args.only)) {
    throw new Error(`--only phải là fc | tt | both (nhận được: ${args.only})`);
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
  npm start -- --dry-run          tính và in kết quả, KHÔNG ghi DB
  npm start -- --tt-months 2      số tháng gần nhất được tính lại TT
  npm start -- --limit 20         chỉ ghi N dòng đầu (để thử)

  npm run serve                   HTTP đọc-thuần trên ${CFG.httpHost}:${CFG.httpPort}
  npm run serve -- --port 4000    đổi cổng
      GET /demand/summary?from=YYYY-MM&to=YYYY-MM&groupBy=cn|month|cn-month|none
                                  tổng FC / MA3 / TT. Không có auth — chỉ nghe localhost.
`);
}
