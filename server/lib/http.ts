// Express helpers. AppKit runs on Express 5, but async rejections must still
// be funneled to a JSON error response, so every handler is wrapped.

import type { Request, Response, RequestHandler } from 'express';
import { HttpError } from './access.js';

type AsyncFn = (req: Request, res: Response) => Promise<void>;

/** Read a route param as a single string (Express 5 types allow string[]). */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Read a query-string value as a single string. */
export function queryStr(req: Request, name: string): string {
  const v = req.query[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

/** Read the `limit` field from a JSON body without tripping unsafe-any. */
export function bodyLimit(req: Request): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  return body?.limit;
}

/** Wrap an async handler so thrown errors become JSON responses. */
export function asyncHandler(fn: AsyncFn): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((err: unknown) => {
      if (res.headersSent) return next(err);
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[route error]', message);
      res.status(500).json({ error: message });
    });
  };
}
