import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable app that works offline: the app itself is cached, and pages you have opened
    // keep their last data. Quizzes work offline from a saved quiz pack (see src/offline.ts).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Exam Readiness Engine',
        short_name: 'Readiness',
        description: 'Know what you will remember on exam day.',
        start_url: '/',
        display: 'standalone',
        background_color: '#F7F8FB',
        theme_color: '#3B4FD8',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff,woff2,ttf,png,svg}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{
          // Data pages: use the network, fall back to the last saved copy when offline.
          urlPattern: ({ url, request }) => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && request.method === 'GET',
          handler: 'NetworkFirst',
          options: { cacheName: 'ere-api', networkTimeoutSeconds: 5, expiration: { maxEntries: 200, maxAgeSeconds: 14 * 86400 } },
        }],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, proxy: { '/api': `http://localhost:${process.env.API_PORT || 3001}` } },
});
