import { z } from 'zod';

/**
 * Lightweight OpenAPI 3.1 registry. Route handlers register their schemas and
 * `pnpm openapi` writes docs/api/openapi.json. Zod 4's native JSON Schema
 * conversion is used, so there is no separate schema language to maintain.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  operationId: string;
  auth: 'public' | 'session' | 'staff' | 'partner' | 'webhook';
  request?: {
    params?: z.ZodObject;
    query?: z.ZodObject;
    body?: z.ZodTypeAny;
    headers?: Record<string, string>;
  };
  responses: Record<number, { description: string; body?: z.ZodTypeAny }>;
  idempotent?: boolean;
}

const routes: RouteSpec[] = [];

export function registerRoute(spec: RouteSpec): RouteSpec {
  const dup = routes.find((r) => r.operationId === spec.operationId);
  if (dup) throw new Error(`duplicate operationId ${spec.operationId}`);
  routes.push(spec);
  return spec;
}

export function listRoutes(): readonly RouteSpec[] {
  return routes;
}

function toJson(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
}

function parameters(spec: RouteSpec): unknown[] {
  const out: unknown[] = [];
  const add = (location: 'path' | 'query', obj?: z.ZodObject) => {
    if (!obj) return;
    const json = toJson(obj) as { properties?: Record<string, unknown>; required?: string[] };
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      out.push({
        name,
        in: location,
        required: location === 'path' ? true : (json.required ?? []).includes(name),
        schema,
      });
    }
  };
  add('path', spec.request?.params);
  add('query', spec.request?.query);
  if (spec.idempotent) {
    out.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      schema: { type: 'string', maxLength: 128 },
      description:
        'Binds the request to requester, endpoint and body hash; conflicting reuse is rejected.',
    });
  }
  return out;
}

export function buildOpenApiDocument(info: {
  title: string;
  version: string;
  serverUrl: string;
}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const pathItem = (paths[r.path] ??= {});
    const responses: Record<string, unknown> = {};
    for (const [status, res] of Object.entries(r.responses)) {
      responses[status] = res.body
        ? {
            description: res.description,
            content: { 'application/json': { schema: toJson(res.body) } },
          }
        : { description: res.description };
    }
    responses['default'] ??= {
      description: 'Error envelope',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
    };
    pathItem[r.method] = {
      operationId: r.operationId,
      summary: r.summary,
      description: r.description,
      tags: r.tags,
      security:
        r.auth === 'public'
          ? []
          : r.auth === 'webhook'
            ? [{ webhookSignature: [] }]
            : [{ sessionCookie: [] }],
      parameters: parameters(r),
      ...(r.request?.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJson(r.request.body) } },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      description:
        'Versioned HTTP API for SimplexD. All money is integer kobo as strings; timestamps are RFC 3339 UTC.',
    },
    servers: [{ url: info.serverUrl }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description: 'Authenticated browser session (HttpOnly cookie).',
        },
        webhookSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'x-paystack-signature',
          description: 'HMAC-SHA512 of the raw body.',
        },
      },
      schemas: {
        ErrorBody: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'correlationId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                correlationId: { type: 'string' },
                details: {},
                retryable: { type: 'boolean' },
                retryAfterSeconds: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    paths,
  };
}
