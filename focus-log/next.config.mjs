/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy.
 *
 * The service-account key lives in this browser (imported non-extractable, so it
 * cannot be read back out — see src/lib/auth/credentials.ts). Script on this
 * origin can still *use* it while the page is open, so the most valuable control
 * here is `connect-src`: even if something malicious executed, it could not ship
 * data to an attacker-controlled host, because the only network destinations
 * permitted are Google's Sheets and OAuth endpoints.
 *
 * `script-src 'unsafe-inline'` is required because Next's App Router emits inline
 * hydration scripts, and per-request nonces need a server, which this app
 * deliberately does not have. That weakens XSS *prevention*, which is exactly why
 * the exfiltration limit above matters.
 */
const csp = [
  "default-src 'self'",
  // Sheets API + the OAuth token endpoint. Nothing else, ever.
  "connect-src 'self' https://sheets.googleapis.com https://oauth2.googleapis.com",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  // No feature in this app needs any of these.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // Sheet contents are personal; keep them out of any shared cache.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
