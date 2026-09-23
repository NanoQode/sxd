import type { MetadataRoute } from 'next';

/**
 * Minimal web app manifest with the design-token theme colours. The icon is a
 * placeholder monogram until approved brand assets arrive.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SimplexD',
    short_name: 'SimplexD',
    description: 'Property services and oversight for Nigerians at home and abroad.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8f6f1',
    theme_color: '#1f5f4b',
    lang: 'en-NG',
    icons: [{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
