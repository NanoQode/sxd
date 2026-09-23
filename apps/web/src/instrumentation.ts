import type { Instrumentation } from 'next';

/**
 * Next.js instrumentation hook: errors that escape server components, server
 * actions, the proxy and route handlers not wrapped by `route()` are reported
 * to the error tracker (when SENTRY_DSN is set). Only the route pattern,
 * method, router/route type and the React digest are sent; the request
 * headers Next hands over are deliberately not read.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportServerError } = await import('./lib/error-reporting');
  const digest =
    typeof err === 'object' && err !== null && 'digest' in err
      ? String((err as { digest: unknown }).digest)
      : null;
  await reportServerError(err, {
    route: context.routePath || request.path,
    method: request.method,
    digest,
    tags: {
      router: context.routerKind,
      route_type: context.routeType,
      render_source: context.renderSource ?? null,
      revalidate: context.revalidateReason ?? null,
    },
  });
};
