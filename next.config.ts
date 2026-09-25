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
    };

export default nextConfig;
