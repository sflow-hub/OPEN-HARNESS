import type { NextConfig } from 'next';

// The mobile app ships the dashboard as static files inside the installed app and talks to
// a remote coordinator over HTTPS, so it has no server of its own to run. Every other target
// keeps the standalone Node server the desktop installer and Docker image depend on.
const mobile = process.env.OPEN_HARNESS_TARGET === 'mobile';

const nextConfig: NextConfig = mobile
  ? {
      // The four app/api routes are coordinator-side and cannot be exported. vinext skips
      // them with a warning, which is correct here: the phone never serves them.
      output: 'export',
      distDir: '.next-mobile',
      images: { unoptimized: true },
    }
  : {
      // The desktop installer embeds this self-contained server output beside its
      // private Node runtime. End users never need Node, npm, or a source checkout.
      output: 'standalone',
      async headers() {
        // Development's Vite client needs its own websocket/evaluation policy.
        if (process.env.NODE_ENV === 'development') return [];
        const csp = [
          "default-src 'self'",
          // React/Vinext emits inline hydration scripts. Until responses have
          // nonces, inline scripts remain allowed; inline event handlers do not.
          "script-src 'self' 'unsafe-inline'",
          "script-src-attr 'none'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          // Desktop chooses a free coordinator port; paired hubs use HTTPS.
          // Tauri uses IPC for native APIs when this page is in its webview.
          "connect-src 'self' https: http://127.0.0.1:* http://localhost:* ipc: http://ipc.localhost",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join('; ');
        return [{
          // Vinext's header matcher needs this form to include the root URL.
          source: '/(.*)',
          headers: [
            { key: 'Content-Security-Policy', value: csp },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'Referrer-Policy', value: 'no-referrer' },
          ],
        }];
      },
    };

export default nextConfig;
