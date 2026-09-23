import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // The monorepo root must be the tracing root so the standalone build carries
  // workspace packages and hoisted dependencies.
  outputFileTracingRoot: path.join(here, '../../'),
  transpilePackages: [
    '@simplexd/ui',
    '@simplexd/domain',
    '@simplexd/contracts',
    '@simplexd/db',
    '@simplexd/integrations',
    '@simplexd/finance',
    '@simplexd/notifications',
  ],
  serverExternalPackages: [
    'pg',
    'pino',
    'pino-pretty',
    'sharp',
    'nodemailer',
    'googleapis',
    'ioredis',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  images: {
    // Only first-party storage hosts are allowed; the list is extended from
    // PUBLIC_MEDIA_HOSTNAMES at build time so no arbitrary remote image is proxied.
    remotePatterns: (process.env.PUBLIC_MEDIA_HOSTNAMES ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
      .map((hostname) => ({ protocol: 'https' as const, hostname })),
  },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      // Private surfaces are never indexed.
      {
        source: '/(portal|admin|partner|tenant|preview)(.*)',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }],
      },
    ];
  },
};

export default nextConfig;
