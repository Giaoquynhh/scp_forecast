import { parseArgs } from './app/cli.js';

/**
 * Điểm vào: chỉ định tuyến, không chứa logic.
 *
 * Các module chạm DB được import ĐỘNG bên trong main() — connection pool được
 * tạo ngay lúc import, nên lỗi cấu hình (DB_SSL sai, thiếu file CA, thiếu
 * DB_PASSWORD) nếu import tĩnh sẽ văng ra ngoài mọi try/catch và in stack trace
 * thô. Import động giữ chúng trong tầm bắt của catch bên dưới.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.migrate) {
    const { migrate } = await import('./infra/migrator.js');
    const { pool } = await import('./infra/db.js');
    console.log('Chạy migration…');
    await migrate();
    await pool.end();
    return;
  }

  if (args.daemon) {
    const { startDaemon } = await import('./app/scheduler.js');
    startDaemon(args.dryRun);
    return; // daemon giữ tiến trình sống, không đóng pool
  }

  if (args.serve) {
    const { buildHttpServer } = await import('./app/container.js');
    const { CFG } = await import('./config.js');
    buildHttpServer().listen(args.port, CFG.httpHost, () => {
      console.log(`Đang nghe http://${CFG.httpHost}:${args.port}`);
      console.log('  GET /health');
      console.log('  GET /demand/summary?from=YYYY-MM&to=YYYY-MM&groupBy=cn');
    });
    return; // server giữ tiến trình sống, không đóng pool
  }

  const { buildRunner } = await import('./app/container.js');
  const { resolveTarget } = await import('./domain/period.js');
  const { pool } = await import('./infra/db.js');

  await buildRunner().run({
    target: resolveTarget(args.month),
    only: args.only,
    dryRun: args.dryRun,
    ttMonths: args.ttMonths,
    limit: args.limit,
  });

  console.log('Xong.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('LỖI:', err instanceof Error ? err.message : err);
  try {
    const { pool } = await import('./infra/db.js');
    await pool.end();
  } catch {
    // pool chưa kịp tạo (lỗi ngay ở khâu cấu hình) — không có gì để đóng.
  }
  process.exit(1);
});
