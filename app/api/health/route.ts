import { getCredential, getEnv, isPasswordProtected } from "@/lib/env";
import { loadSitesConfig } from "@/lib/sites";

export const dynamic = "force-dynamic";

/** 健康检查 / 配置自检：前端据此展示全局提示 */
export async function GET() {
  const env = getEnv();
  const loaded = await loadSitesConfig(env.SITES_KV);
  const cred = getCredential();
  return Response.json(
    {
      ok: true,
      credentialsConfigured: cred.ok,
      credentialsError: cred.ok ? undefined : cred.message,
      passwordProtected: isPasswordProtected(),
      kvAvailable: loaded.kvAvailable,
      kvWarning: loaded.kvWarning,
      siteCount: loaded.config.sites.length,
      source: loaded.source,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
