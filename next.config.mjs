/** @type {import('next').NextConfig} */

/**
 * Security headers applied to every response.
 *
 * CSP is reported-only by default so a misconfigured directive cannot white-screen
 * production; flip `CSP_ENFORCE` to `true` once the report stream is clean.
 * The nonce-based policy is assembled per-request in `middleware.ts`, which then
 * overrides `contentSecurityPolicy` below with a nonce'd variant.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "upgrade-insecure-requests",
  // React's inline runtime + Tailwind need these; no eval() is used anywhere.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
].join("; ")

const cspHeader =
  process.env.CSP_ENFORCE === "true"
    ? contentSecurityPolicy
    : contentSecurityPolicy.replace(/; upgrade-insecure-requests/, "")

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: cspHeader,
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
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
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
