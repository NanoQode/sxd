import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';

/** Private surfaces, previews and the API are never crawled. */
export default function robots(): MetadataRoute.Robots {
  const base = env().APP_URL.replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/portal', '/admin', '/partner', '/tenant', '/preview', '/api', '/setup'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
