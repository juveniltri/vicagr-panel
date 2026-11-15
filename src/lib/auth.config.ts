import type { NextAuthConfig } from "next-auth";

export const authConfig: NextAuthConfig = {
  pages: { signIn: "/login", error: "/login" },
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  trustHost: true,
  // Only the session cookie: the ones of the Pocket ID flow (state, PKCE,
  // nonce) must stay Lax or the provider's redirect back arrives without them.
  // Auth.js merges this over its defaults (name, HttpOnly, Secure).
  cookies: { sessionToken: { options: { sameSite: "strict" } } },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
  providers: [],
};
