import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow the app to be loaded through an ngrok tunnel. Without this,
  // Next dev blocks the tunnel origin's HMR/asset requests, the client bundle
  // never hydrates, and nothing interactive works. Wildcards cover the changing
  // free-tier subdomain and static/paid ngrok domains. Has no effect in prod.
  allowedDevOrigins: [
    "1223-2a0d-6fc0-2319-8100-8df9-803a-237a-9a0a.ngrok-free.app",
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
  ],
  experimental: {
    // Server Actions run a CSRF check comparing the request Origin to the host.
    // Over a tunnel the browser Origin is the ngrok host, so allow it or form
    // submits (Server Actions) are silently rejected.
    serverActions: {
      allowedOrigins: [
        "1223-2a0d-6fc0-2319-8100-8df9-803a-237a-9a0a.ngrok-free.app",
        "*.ngrok-free.app",
        "*.ngrok.app",
        "*.ngrok.io",
      ],
    },
  },
};

export default nextConfig;
