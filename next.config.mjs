/** @type {import('next').NextConfig} */

/**
 * Security headers applied to every response. Next.js development bundles use
 * eval-based source maps and WebSockets for hot reload; production does not.
 *
 * Embedded previews are explicitly opt-in and only available in development.
 * They relax clickjacking protection, so never use them with sensitive data.
 * Production always keeps frame-ancestors 'none' and X-Frame-Options: DENY.
 */
const isDevelopment = process.env.NODE_ENV === "development"
const allowPreviewEmbedding = isDevelopment && process.env.WMS_PREVIEW_EMBED === "true"
// Enforce by default. Set CSP_ENFORCE=false at build time for report-only mode.
const enforceCsp = process.env.CSP_ENFORCE !== "false"

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  allowPreviewEmbedding ? "frame-ancestors *" : "frame-ancestors 'none'",
  "form-action 'self'",
  // React's inline runtime requires unsafe-inline. Webpack's development-only
  // source maps additionally require unsafe-eval.
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDevelopment ? " ws: wss:" : ""}`,
  "manifest-src 'self'",
  ...(enforceCsp && !isDevelopment ? ["upgrade-insecure-requests"] : []),
].join("; ")

const securityHeaders = [
  {
    key: enforceCsp ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
    value: contentSecurityPolicy,
  },
  {
    key: "Strict-Transport-Security",
    // 2 years + preload + subdomains. Only meaningful behind TLS.
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  ...(allowPreviewEmbedding ? [] : [{ key: "X-Frame-Options", value: "DENY" }]),
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self), browsing-topics=(), interest-cohort=()",
  },
  {
    // Never cache authenticated API responses or HTML in shared caches.
    key: "Cache-Control",
    value: "no-store, max-age=0",
  },
  {
    key: "X-DNS-Prefetch-Control",
    value: "off",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
]

const nextConfig = {
  // Fail the build on type errors — a regression here previously hid 108 errors.
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Next 14 requires this flag to run instrumentation.ts at server startup.
  experimental: { instrumentationHook: true },
  // Required for the slim container image used in production deployments.
  output: "standalone",
  images: {
    // Static export / object-storage friendly; switch to `false` when a
    // sharp-enabled runtime image is used.
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Long-lived caching for immutable hashed assets only.
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ]
  },
}

export default nextConfig
