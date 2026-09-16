import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The desktop installer embeds this self-contained server output beside its
  // private Node runtime. End users never need Node, npm, or a source checkout.
  output: "standalone",
};

export default nextConfig;
