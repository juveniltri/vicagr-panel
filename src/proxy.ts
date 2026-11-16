import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

// NOTE: keep this the only proxy/middleware file. With a root middleware.ts next
// to it, `next build` used one and `next dev` mixed both, sending /api to login.
// /api routes check the session themselves (or, like the GitHub webhook, have
// none), so they stay out of the matcher.
const { auth } = NextAuth(authConfig);

function politica(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // Monaco and React set style attributes, which a nonce cannot allow.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // Monaco starts its web workers from blob: URLs.
    "worker-src blob: 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export default auth((req) => {
  if (!req.auth && req.nextUrl.pathname !== "/login") {
    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(login);
  }
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  // Next.js reads the nonce from the request's CSP and puts it on its scripts.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = politica(nonce);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon\\.ico).*)"],
};
