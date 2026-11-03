import { getCachedJson } from "@/lib/cache";
import { getCredential, getEnv } from "@/lib/env";
import { requireSession } from "@/lib/guards";
import { DETAIL_RANGE_LABELS, fetchSiteDetail } from "@/lib/queries";
import { hashConfig, loadSitesConfig } from "@/lib/sites";
import type { RangeKey, SiteDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

const CACHE_TTL_SECONDS = 300;

function parseRange(value: string | null): RangeKey {
  return value === "today" || value === "yesterday" || value === "7d" || value === "30d"
    ? value
    : "7d";
}

/**
 * 单站点详情：国家/设备/热门页面/流量来源 + 范围趋势。
 * 结果缓存 5 分钟；?refresh=1 跳过缓存读取。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const { id } = await context.params;
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const forceRefresh = url.searchParams.get("refresh") === "1";

  const loaded = await loadSitesConfig(getEnv().SITES_KV);
  const site = loaded.config.sites.find((s) => s.id === id);
  if (!site) {
    return Response.json({ error: `站点不存在：${id}` }, { status: 404 });
  }

  const cred = getCredential();
  const cacheKey = `detail:v1:${site.id}:${range}:${hashConfig(loaded.config)}`;

  const result = await getCachedJson<Omit<SiteDetail, "fetchedAt">>(
    cacheKey,
    CACHE_TTL_SECONDS,
    async () => {
      if (!cred.ok) {
        return {
          siteId: site.id,
          range,
          totals: { users: 0, pageviews: 0, sessions: 0 },
          daily: [],
          countries: [],
          devices: [],
          pages: [],
          sources: [],
          error: { code: cred.code, message: cred.message },
        };
      }
      return fetchSiteDetail(cred.cred, site, range);
    },
    { forceRefresh },
  );

  return Response.json(
    { fetchedAt: result.cachedAt, ...result.data },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Cache": result.fromCache ? "HIT" : "MISS",
        "X-Range-Label": DETAIL_RANGE_LABELS[range],
      },
    },
  );
}
