import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // This is an API-only Next.js project — no pages, no static assets.
  // We disable the default React rendering to keep the bundle minimal.
  reactStrictMode: true,

  // Allow large request bodies for QR image uploads (up to 4 MB).
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
};

export default nextConfig;
