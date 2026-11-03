import { createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS, timingSafeEqual } from "@/lib/auth";
import { getEnv, isPasswordProtected } from "@/lib/env";

export const dynamic = "force-dynamic";

interface LoginBody {
  password?: string;
}

/** 登录：校验密码并签发 HttpOnly Cookie 会话 */
export async function POST(request: Request) {
  if (!isPasswordProtected()) {
    return Response.json({ ok: true, open: true }, { headers: { "Cache-Control": "no-store" } });
  }

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }

  const password = getEnv().DASHBOARD_PASSWORD ?? "";
  const submitted = typeof body.password === "string" ? body.password : "";
  // 先走一次恒定时间比较，长度不同也保持恒定耗时差异可忽略（密码为服务端配置值）
  if (!submitted || !timingSafeEqual(submitted, password)) {
    return Response.json({ error: "密码不正确" }, { status: 401 });
  }

  const token = await createSessionToken(password);
  const secure = new URL(request.url).protocol === "https:";
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
      secure ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  res.headers.set("Cache-Control", "no-store");
  return res;
}
