import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";

export const AUTH_COOKIE = "ft_auth";

/**
 * Dashboard gate. The cookie is an HMAC-signed session (see lib/auth) — the
 * password is never stored in it. We verify the signature here (Web Crypto works
 * in the edge runtime) and reject anything unsigned or tampered.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/dashboard/login") || pathname.startsWith("/dashboard/reset")) return NextResponse.next();

  const payload = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!payload) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
