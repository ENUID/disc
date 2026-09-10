import type { NextConfig } from "next";

/**
 * The dashboard renders entirely on the server and holds a merchant
 * bearer token in an httpOnly cookie, so the headers below are not
 * decoration: they are what stops another origin framing this page and
 * driving it, and what stops the token leaking through a referrer.
 */
const config: NextConfig = {
  reactStrictMode: true,
  // Never expose which framework version is serving merchant data.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // The OAuth callback hands the session token over in a query
          // string. Without this, the first outbound link would carry it
          // in a Referer header.
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default config;
