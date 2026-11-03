import { getCachedJson } from "@/lib/cache";
import { getCredential, getEnv } from "@/lib/env";
import { requireSession } from "@/lib/guards";
import { fetchAllSitesHistory } from "@/lib/queries";
import { hashConfig, loadSitesConfig } from "@/lib/sites";
import type { HistoryResponse, MetricSet, SiteHistory } from "@/lib/types";

export const dynamic = "force-dynamic";

const CACHE_TTL_SECONDS = 300;

const EMPTY_METRICS: MetricSet = { users: 0, pageviews: 0, sessions: 0 };

/**
 * 全部站点历史统计（今日/昨日/近 7 天/近 30 天 + 趋势 + 异常）。
 * 结果整体缓存 5 分钟；?refresh=1 跳过缓存读取（手动刷新）。
 */
export async function GET(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const env = getEnv();
  const loaded = await loadSitesConfig(env.SITES_KV);
  const cred = getCredential();
  const threshold = loaded.config.anomalyThreshold;
  const cacheKey = `history:v1:${hashConfig(loaded.config)}`;

  const result = await getCachedJson<Omit<HistoryResponse, "fetchedAt">>(
    cacheKey,
    CACHE_TTL_SECONDS,
    async () => {
      let sites: SiteHistory[];
      if (!cred.ok) {
        sites = loaded.config.sites.map((site) => ({
          siteId: site.id,
          today: { ...EMPTY_METRICS, prev: EMPTY_METRICS, usersChangePct: null, pageviewsChangePct: null },
          yesterday: { ...EMPTY_METRICS, prev: EMPTY_METRICS, usersChangePct: null, pageviewsChangePct: null },
          last7: { ...EMPTY_METRICS, prev: EMPTY_METRICS, usersChangePct: null, pageviewsChangePct: null },
          last30: { ...EMPTY_METRICS, prev: EMPTY_METRICS, usersChangePct: null, pageviewsChangePct: null },
          daily: [],
          hourly: [],
          sameTimeToday: EMPTY_METRICS,
          sameTimeYesterday: EMPTY_METRICS,
          error: { code: cred.code, message: cred.message },
          fetchedAt: new Date().toISOString(),
        }));
      } else {
        sites = await fetchAllSitesHistory(cred.cred, loaded.config.sites, threshold);
      }

      // 全部站点各周期合计（仅统计成功返回的站点）
      const totals: HistoryResponse["totals"] = {
        today: { ...EMPTY_METRICS },
        yesterday: { ...EMPTY_METRICS },
        last7: { ...EMPTY_METRICS },
        last30: { ...EMPTY_METRICS },
      };
      for (const site of sites) {
        if (site.error) continue;
        for (const key of ["today", "yesterday", "last7", "last30"] as const) {
          const period = site[key];
          totals[key] = {
            users: totals[key].users + period.users,
            pageviews: totals[key].pageviews + period.pageviews,
            sessions: totals[key].sessions + period.sessions,
          };
        }
      }
      return { anomalyThreshold: threshold, sites, totals };
    },
    { forceRefresh },
  );

  return Response.json(
    { fetchedAt: result.cachedAt, ...result.data },
    { headers: { "Cache-Control": "no-store", "X-Cache": result.fromCache ? "HIT" : "MISS" } },
  );
}
