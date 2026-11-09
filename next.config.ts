import type { NextConfig } from "next";

/**
 * Set at BUILD time as well as at run time (render.yaml sets it for both): response headers are fixed when the app is built.
 * Demo mode adds HSTS (the platform terminates TLS) and asks crawlers not to index a throwaway demo.
 */
const demo = process.env.DEPLOY_MODE === "demo";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The app serves no images, so the image optimisation endpoint (/_next/image, the target of a past critical advisory) is switched off.
  images: { unoptimized: true },
  headers: () =>
    Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          ...(demo
            ? [
                { key: "Strict-Transport-Security", value: "max-age=15552000" },
                { key: "X-Robots-Tag", value: "noindex, nofollow" },
              ]
            : []),
          // ponytail: no CSP yet; add a nonce-based CSP with the Arena UI (AC-P0-12).
        ],
      },
    ]),
};

export default config;
