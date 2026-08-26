import type { Server } from 'node:http';
import { CFG } from '../config.js';
import { pool } from '../infra/db.js';
import { SalesRepository } from '../infra/sales.repository.js';
import { BranchForecastRepository } from '../infra/branch-forecast.repository.js';
import { SummaryRepository } from '../infra/summary.repository.js';
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
    writer: new BranchForecastRepository(pool, CFG.chunkSize),
    weights: CFG.weights,
    blockMode: CFG.blockMode,
    perDayDivisor: CFG.perDayDivisor,
    sourceFc: CFG.sourceFc,
    sourceTt: CFG.sourceTt,
    actor: CFG.actor,
  });
  return new Runner(service);
}

/** Server đọc-thuần cho GET /demand/summary. Dùng chung pool với lượt tính. */
export function buildHttpServer(): Server {
  return createHttpServer({
    summary: new SummaryService(new SummaryRepository(pool)),
  });
}
