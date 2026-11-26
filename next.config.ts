import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The dev server (systemd service) is opened from other machines by its LAN and tailnet addresses.
  // Without these, Next.js blocks live updates and dev assets for those origins, so open tabs keep the old UI.
  allowedDevOrigins: ["100.99.139.44", "192.168.1.15", "spark-2850", "spark-2850-1", "*.ts.net"],
  devIndicators: false,
  // The dev server would otherwise write every server action's arguments to the journal (draft text, case details,
  // and the one-time Google sign-in code when Gmail is connected).
  logging: { serverFunctions: false },
  // Native SQLite driver and the PDF text extractor must run as plain Node modules.
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3", "unpdf"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
