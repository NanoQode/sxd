import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, correlationIdHeader, type ErrorCode } from '@simplexd/contracts';
import { AuthorizationError } from '@simplexd/domain/authz';
import { reportServerError } from '../error-reporting';
import { logger } from '../logger';

/** JSON replacer that serialises bigint (kobo) as decimal strings and Dates as ISO. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function correlationIdFrom(req: Request): string {
  const incoming = req.headers.get(correlationIdHeader);
  if (incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming)) return incoming;
  return randomUUID();
}

export function json<T>(
  body: T,
  init: { status?: number; headers?: Record<string, string>; correlationId?: string } = {},
): NextResponse {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', headers.get('cache-control') ?? 'no-store');
  if (init.correlationId) headers.set(correlationIdHeader, init.correlationId);
  return new NextResponse(JSON.stringify(body, jsonReplacer), {
    status: init.status ?? 200,
    headers,
  });
}

export function errorResponse(err: unknown, correlationId: string): NextResponse {
  const log = logger();
  if (err instanceof ApiError) {
    if (err.status >= 500) log.error({ err, correlationId }, 'api error');
    const headers: Record<string, string> = {};
    if (err.retryAfterSeconds !== undefined) headers['retry-after'] = String(err.retryAfterSeconds);
    return json(err.toBody(correlationId), { status: err.status, headers, correlationId });
  }
  if (err instanceof AuthorizationError) {
    const code: ErrorCode =
      err.decision.code === 'unauthenticated'
        ? 'unauthenticated'
        : err.decision.code === 'mfa_required'
          ? 'mfa_required'
          : 'forbidden';
    return json(
      new ApiError(code, err.decision.reason, { details: { code: err.decision.code } }).toBody(
        correlationId,
      ),
      {
        status: code === 'unauthenticated' ? 401 : 403,
        correlationId,
      },
    );
  }
  if (err instanceof z.ZodError) {
    const details = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    return json(
      new ApiError('validation_failed', 'request validation failed', { details }).toBody(
        correlationId,
      ),
      { status: 400, correlationId },
    );
  }
  log.error({ err, correlationId }, 'unhandled api error');
  return json(
    new ApiError(
      'internal_error',
      'something went wrong; quote the correlation id to support',
    ).toBody(correlationId),
    {
      status: 500,
      correlationId,
    },
  );
}

/**
 * Wraps a route handler with correlation ids, error mapping and structured
 * request logging. Handlers throw ApiError/AuthorizationError/ZodError.
 */
export function route<Ctx>(
  handler: (req: Request, ctx: Ctx & { correlationId: string }) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const correlationId = correlationIdFrom(req);
    const started = Date.now();
    try {
      const res = await handler(req, { ...ctx, correlationId });
      if (!res.headers.has(correlationIdHeader))
        res.headers.set(correlationIdHeader, correlationId);
      logger().info(
        {
          method: req.method,
          path: new URL(req.url).pathname,
          status: res.status,
          ms: Date.now() - started,
          correlationId,
        },
        'request',
      );
      return res;
    } catch (err) {
      const res = errorResponse(err, correlationId);
      const path = new URL(req.url).pathname;
      if (res.status >= 500) {
        // Error tracking (SENTRY_DSN): sanitized event with the correlation id and route only.
        void reportServerError(err, { correlationId, route: path, method: req.method });
      }
      logger().info(
        {
          method: req.method,
          path,
          status: res.status,
          ms: Date.now() - started,
          correlationId,
        },
        'request',
      );
      return res;
    }
  };
}

export async function parseJson<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('validation_failed', 'request body must be valid JSON');
  }
  return schema.parse(raw);
}

export function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const url = new URL(req.url);
  const obj: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams.entries()) {
    const existing = obj[k];
    if (existing === undefined) obj[k] = v;
    else obj[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
  }
  return schema.parse(obj);
}

export async function params<T extends z.ZodTypeAny>(
  ctx: { params: Promise<unknown> | unknown },
  schema: T,
): Promise<z.infer<T>> {
  const resolved = await ctx.params;
  return schema.parse(resolved);
}
