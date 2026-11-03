/**
 * 认证守卫：API 路由与页面共用的会话校验。
 *
 * 不使用框架级 proxy/middleware（vinext 在 dev/preview 的缓存适配层对其
 * cookie 传递不稳定），而是每个受保护入口显式调用，行为完全确定：
 * - API：requireSession(request) → 401 JSON
 * - 页面：requirePageSession() → redirect("/login")
 * - DASHBOARD_PASSWORD 未设置时一律放行。
 */

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "./auth";
import { getEnv, isPasswordProtected } from "./env";

/** 已登录（或未启用密码保护）返回 null，否则返回 401 响应 */
export async function requireSession(request: Request): Promise<Response | null> {
  if (!isPasswordProtected()) return null;
  // 统一走 next/headers 读取 Cookie（vinext 在部分请求路径上不会把 Cookie
  // 头透传给 route handler 的 request 对象，而 next/headers 始终可靠）
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return unauthorized();
  const password = getEnv().DASHBOARD_PASSWORD ?? "";
  if (await verifySessionToken(token, password)) return null;
  return unauthorized();
}

/** 页面守卫：未登录时重定向到 /login（携带 next 参数） */
export async function requirePageSession(nextPath?: string): Promise<void> {
  if (!isPasswordProtected()) return;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const password = getEnv().DASHBOARD_PASSWORD ?? "";
    if (await verifySessionToken(token, password)) return;
  }
  const target = nextPath && nextPath !== "/" ? `/login?next=${encodeURIComponent(nextPath)}` : "/login";
  redirect(target);
}

function unauthorized(): Response {
  return Response.json({ error: "未登录或会话已过期" }, { status: 401 });
}
