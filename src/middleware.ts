import { NextRequest, NextResponse } from "next/server";

export const AUTH_COOKIE = "ft_auth";

/**
 * Simple password gate for the owner dashboard (MVP-grade auth). The login action
 * sets an httpOnly cookie equal to DASHBOARD_PASSWORD; here we just check it.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/dashboard/login")) return NextResponse.next();

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected || cookie !== expected) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
