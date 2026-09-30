/**
 * Điểm vào: chỉ định tuyến, không chứa logic.
 *
 * MỌI import đều nằm trong main() chứ không ở đầu file. Lý do: `config.ts` kiểm
 * tra biến môi trường ngay lúc nạp module (FC_DAY_OF_MONTH sai, thiếu DB_PASSWORD,
 * DB_SSL=verify-full mà không có file CA), còn `db.ts` tạo connection pool ngay
 * lúc nạp. Import tĩnh thì những lỗi đó văng ra TRƯỚC khi main() chạy, nằm ngoài
 * mọi try/catch, và người dùng nhận một stack trace thô thay vì một dòng nói rõ
 * biến nào sai. Import động giữ chúng trong tầm bắt của catch bên dưới.
 */
async function main(): Promise<void> {
  const { parseArgs } = await import('./app/cli.js');
  const args = parseArgs(process.argv.slice(2));

  if (args.migrate) {
    const { migrate } = await import('./infra/migrator.js');
    const { pool } = await import('./infra/db.js');
    console.log('Chạy migration…');
    await migrate();
    await pool.end();
    return;
  }

  if (args.accuracy) {
    const { buildAccuracyService } = await import('./app/container.js');
    const { printAccuracySummary } = await import('./app/accuracy.service.js');
    const { refreshWindow } = await import('./domain/accuracy.js');
    const { addMonths, resolveTarget, toDateOnly } = await import('./domain/period.js');
    const { pool } = await import('./infra/db.js');

    let periods: string[] | undefined;
    if (args.from || args.to) {
      const win = refreshWindow(new Date());
      const from = args.from ? resolveTarget(args.from) : new Date(`${win[0]}T00:00:00Z`);
      const to = args.to ? resolveTarget(args.to) : new Date(`${win[win.length - 1]}T00:00:00Z`);
      periods = [];
      for (let d = from; d <= to; d = addMonths(d, 1)) periods.push(toDateOnly(d));
    }
    const s = await buildAccuracyService().run({ periods, force: args.force, dryRun: args.dryRun });
    printAccuracySummary(s, args.dryRun);
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
  const { firstOfMonth, resolveTarget } = await import('./domain/period.js');
  const { CFG } = await import('./config.js');
  const { pool } = await import('./infra/db.js');

  const now = new Date();
  await buildRunner().run({
    target: resolveTarget(args.month, CFG.fcTarget),
    // `--month` là chỉ định tường minh: cả FC lẫn TT đều theo tháng đó, để lệnh
    // backfill giữ nguyên nghĩa cũ. Chỉ khi KHÔNG truyền --month thì TT mới phải
    // tách ra tháng hiện tại, vì lúc đó FC đã nhắm tháng sau.
    ttTarget: args.month
      ? resolveTarget(args.month)
      : firstOfMonth(now.getFullYear(), now.getMonth()),
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
