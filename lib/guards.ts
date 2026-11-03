/**
 * 路由级会话守卫（中间件之外的第二道防线，用于写操作 API）。
 * 仅服务器端使用。
 */

import { sessionFromCookieHeader, verifySessionToken } from "./auth";
import { getEnv, isPasswordProtected } from "./env";

/** 已登录（或未启用密码保护）返回 null，否则返回 401 响应 */
export async function requireSession(request: Request): Promise<Response | null> {
  if (!isPasswordProtected()) return null;
  const token = sessionFromCookieHeader(request.headers.get("cookie"));
  if (!token) return unauthorized();
  const password = getEnv().DASHBOARD_PASSWORD ?? "";
  if (await verifySessionToken(token, password)) return null;
  return unauthorized();
}

function unauthorized(): Response {
  return Response.json({ error: "未登录或会话已过期" }, { status: 401 });
}
