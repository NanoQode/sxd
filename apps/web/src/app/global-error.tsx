'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Last-resort boundary when the root layout itself fails. Renders its own
 * html/body with inline styles because the design tokens may not have loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('global error', error.digest ?? error.message);
  }, [error]);
  return (
    <html lang="en-NG">
      <body
        style={{
          margin: 0,
          fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
          background: '#f8f6f1',
          color: '#1f2421',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}
      >
        <main style={{ maxWidth: 560 }}>
          <p style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: '#5b625e' }}>
            SimplexD
          </p>
          <h1 style={{ fontSize: 28, margin: '4px 0 8px' }}>The site could not load</h1>
          <p style={{ color: '#5b625e', lineHeight: 1.5 }}>
            An unexpected error stopped the page from rendering. Nothing has been lost on our side;
            please try again in a moment.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, color: '#7c837f' }}>Reference: {error.digest}</p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: '#1f5f4b',
                color: '#fff',
                border: 0,
                borderRadius: 10,
                padding: '12px 16px',
                minHeight: 44,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <Link
              href="/"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                border: '1px solid #b9b2a4',
                borderRadius: 10,
                padding: '12px 16px',
                minHeight: 44,
                fontSize: 14,
                color: '#1f2421',
                textDecoration: 'none',
              }}
            >
              Homepage
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
