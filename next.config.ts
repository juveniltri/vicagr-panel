import type { NextConfig } from "next";

// TODO: reemplazar [DOMINIO] con el dominio real del panel (ej: panel.tudominio.com)
const PANEL_DOMAIN = process.env.PANEL_DOMAIN ?? "[DOMINIO]";

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // The Content-Security-Policy goes out from src/proxy.ts: it carries a nonce
  // per request.
];

const nextConfig: NextConfig = {
  // La compresión gzip por defecto de `next start` bufferiza la respuesta
  // hasta tener suficiente contenido, rompiendo el streaming en tiempo real
  // de los logs de deploy (SSE) en producción.
  compress: false,

  // ssh2 usa módulos nativos (.node) que Turbopack no puede empaquetar en ESM.
  // Externalizarlos hace que Node.js los resuelva en runtime desde node_modules.
  serverExternalPackages: ["ssh2", "dockerode", "docker-modem"],

  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/(.*)", headers: securityHeaders }];
  },

  async redirects() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "header", key: "x-forwarded-proto", value: "http" }],
        destination: `https://${PANEL_DOMAIN}/:path*`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
