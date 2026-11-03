import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionFromCookieHeader, verifySessionToken } from "./lib/auth";
import { getEnv, isPasswordProtected } from "./lib/env";

/**
 * 全站登录保护（Next.js 16 proxy 约定）：设置了 DASHBOARD_PASSWORD 时，
 * 除 /login 与 /api/auth/* 外的所有页面与 API 都要求有效会话；未设置时完全开放。
 */
export async function proxy(request: NextRequest) {
  if (!isPasswordProtected()) return NextResponse.next();

  const token = sessionFromCookieHeader(request.headers.get("cookie"));
  const password = getEnv().DASHBOARD_PASSWORD ?? "";
  if (token && (await verifySessionToken(token, password))) {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", `${pathname}${search}`);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
