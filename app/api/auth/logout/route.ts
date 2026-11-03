import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** 退出登录：清空会话 Cookie */
export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  res.headers.set("Cache-Control", "no-store");
  return res;
}
