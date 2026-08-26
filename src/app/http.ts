import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BadQueryError, parseSummaryQuery } from '../domain/summary.js';
import type { SummaryService } from './summary.service.js';

/**
 * HTTP server nhỏ cho endpoint tổng — `node:http` thuần, KHÔNG thêm dependency.
 *
 * Vì sao không dùng Express/Nest: app này có đúng 2 route đọc-thuần, không thân
 * người dùng, không upload, không session. Một framework ở đây chỉ thêm 50+ package
 * vào cây phụ thuộc của một tiến trình cron.
 *
 * Vì sao không đặt endpoint bên SmartlogSCP.Backend: app này độc lập, không đụng
 * code SCP — cùng lý do nó ghi DB trực tiếp thay vì gọi API. Đổi lại, ở đây KHÔNG
 * có auth/RBAC của SCP: đừng mở cổng này ra Internet.
 *
 *   GET /health           → { ok: true }
 *   GET /demand/summary   → tổng FC / MA3 / TT
 */

export interface HttpDeps {
  summary: SummaryService;
  /** In log mỗi request. Đặt false trong test cho đỡ ồn. */
  log?: boolean;
}

export function createHttpServer(deps: HttpDeps): Server {
  const log = deps.log !== false;

  return createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      // Lỗi ngoài dự tính (DB sập, cột ma3 chưa migrate…) — trả 500, không lộ stack
      // ra client nhưng vẫn in đủ ở server để còn lần được nguyên nhân.
      console.error('LỖI HTTP:', err);
      send(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  }).on('request', (req: IncomingMessage) => {
    if (log) console.log(`${req.method} ${req.url}`);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
): Promise<void> {
  if (req.method !== 'GET') {
    send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Chỉ hỗ trợ GET' } });
    return;
  }

  // base chỉ để URL parse được đường dẫn tương đối; host thật không dùng tới.
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/demand/summary') {
    try {
      const query = parseSummaryQuery(url.searchParams);
      const data = await deps.summary.summarize(query);
      send(res, 200, { data });
    } catch (err) {
      // Sai tham số là lỗi của người gọi → 400. Mọi lỗi khác để catch ngoài lo.
      if (err instanceof BadQueryError) {
        send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } });
        return;
      }
      throw err;
    }
    return;
  }

  send(res, 404, {
    error: {
      code: 'NOT_FOUND',
      message: `Không có route ${url.pathname}. Có: GET /health, GET /demand/summary`,
    },
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
