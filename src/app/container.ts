import type { Server } from 'node:http';
import { CFG } from '../config.js';
import { pool } from '../infra/db.js';
import { SalesRepository } from '../infra/sales.repository.js';
import { BranchForecastRepository } from '../infra/branch-forecast.repository.js';
import { SummaryRepository } from '../infra/summary.repository.js';
import { SystemConfigRepository } from '../infra/system-config.repository.js';
import { AccuracyRepository } from '../infra/accuracy.repository.js';
import { AccuracyService } from './accuracy.service.js';
import { ForecastService } from './forecast.service.js';
import { SummaryService } from './summary.service.js';
import { createHttpServer } from './http.js';
import { Runner } from './runner.js';

/**
 * Composition root — chỗ DUY NHẤT ghép các tầng lại với nhau. Mọi chỗ khác chỉ
 * biết interface, không biết Postgres. Đổi nguồn dữ liệu hay đổi đích ghi thì
 * sửa ở đây, không lan ra chỗ khác.
 */
export function buildRunner(): Runner {
  const service = new ForecastService({
    sales: new SalesRepository(pool),
    writer: new BranchForecastRepository(pool, CFG.chunkSize, CFG.sourceFc),
    config: new SystemConfigRepository(pool),
    weights: CFG.weights,
    blockMode: CFG.blockMode,
    perDayDivisor: CFG.perDayDivisor,
    sourceFc: CFG.sourceFc,
    sourceTt: CFG.sourceTt,
    actor: CFG.actor,
    zeroWhenDormant: CFG.fcZeroWhenDormant,
  });
  return new Runner(service);
}

/** Dựng bảng forecast_accuracy_* (sau mỗi lượt cron, hoặc chạy tay --accuracy). */
export function buildAccuracyService(): AccuracyService {
  return new AccuracyService(new AccuracyRepository(pool));
}

/** Server đọc-thuần cho GET /demand/summary. Dùng chung pool với lượt tính. */
export function buildHttpServer(): Server {
  return createHttpServer({
    summary: new SummaryService(new SummaryRepository(pool)),
  });
}
