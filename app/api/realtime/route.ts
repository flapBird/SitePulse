import { getCachedJson } from "@/lib/cache";
import { getCredential, getEnv } from "@/lib/env";
import { requireSession } from "@/lib/guards";
import { fetchAllSitesRealtime } from "@/lib/queries";
import { hashConfig, loadSitesConfig } from "@/lib/sites";
import type { RealtimeResponse, SiteRealtime } from "@/lib/types";

export const dynamic = "force-dynamic";

const CACHE_TTL_SECONDS = 60;

/**
 * 全部站点实时数据（过去 30 分钟）。结果整体缓存 60 秒：
 * 无论多少访问者、多少次轮询，每分钟最多打一次 GA4。
 * ?refresh=1 跳过缓存读取（手动刷新），但结果仍会回写缓存。
 */
export async function GET(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const env = getEnv();
  const loaded = await loadSitesConfig(env.SITES_KV);
  const cred = getCredential();
  const cacheKey = `realtime:v1:${hashConfig(loaded.config)}`;

  const result = await getCachedJson<Omit<RealtimeResponse, "fetchedAt">>(
    cacheKey,
    CACHE_TTL_SECONDS,
    async () => {
      if (!cred.ok) {
        // 凭据未配置：每个站点挂上同一错误，表格仍可展示站点清单
        const sites: SiteRealtime[] = loaded.config.sites.map((site) => ({
          siteId: site.id,
          activeUsers: 0,
          pageviews: 0,
          trend: [],
          error: { code: cred.code, message: cred.message },
          fetchedAt: new Date().toISOString(),
        }));
        return {
          credentialsConfigured: false,
          credentialsError: cred.message,
          sites,
          totals: { activeUsers: 0, pageviews: 0 },
        };
      }

      const sites = await fetchAllSitesRealtime(cred.cred, loaded.config.sites);
      const totals = sites.reduce(
        (acc, s) => ({
          activeUsers: acc.activeUsers + (s.error ? 0 : s.activeUsers),
          pageviews: acc.pageviews + (s.error ? 0 : s.pageviews),
        }),
        { activeUsers: 0, pageviews: 0 },
      );
      return { credentialsConfigured: true, sites, totals };
    },
    { forceRefresh },
  );

  return Response.json(
    { fetchedAt: result.cachedAt, ...result.data },
    { headers: { "Cache-Control": "no-store", "X-Cache": result.fromCache ? "HIT" : "MISS" } },
  );
}
