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
  // Reference thumbnails, covers and library images render through next/image
  // from Vercel Blob. Store hosts are `<store-id>.public.blob.vercel-storage.com`.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com", search: "" }],
  },
  // `sharp` is external by default (it is on Next's own
  // server-external-packages list), so the deployed function `require`s it at
  // runtime rather than bundling it — which means file tracing has to ship
  // its native library too. Tracing followed the JS and stopped: production
  // 500'd on every route that transitively imports image code with
  // "ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object
  // file". The .so lives in a sibling package (@img/sharp-libvips-linux-x64)
  // reached only through a platform-gated optional dependency, which is
  // exactly the edge tracing misses.
  //
  // Keyed "/**" because the import is not confined to the image routes: the
  // dashboard layout pulls in `blob.ts` for a nav count, and `blob.ts`
  // imports a constant from `compress.ts`, which imports sharp at module
  // scope. Every server route in the app is downstream of that.
  //
  // The whole @img tree, not just linux-x64: the glob is evaluated where the
  // build runs, and naming one platform would silently trace nothing at all
  // if that ever changes.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/@img/**"],
  },
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
      // Image uploads accept files up to 10 MB (UPLOAD_MAX_BYTES); the default
      // 1 MB action body would reject them. Headroom for multipart framing.
      bodySizeLimit: "11mb",
    },
  },
};

export default nextConfig;
