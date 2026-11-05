import { getCachedJson } from "@/lib/cache";
import { getCredential, getEnv } from "@/lib/env";
import { fetchSiteFunnel, findFunnel, FUNNEL_RANGES, DEFAULT_FUNNEL_RANGE } from "@/lib/funnel";
import { requireSession } from "@/lib/guards";
import { runReport } from "@/lib/ga4";
import { hashConfig, loadSitesConfig } from "@/lib/sites";
import { zonedDate } from "@/lib/datetime";
import type { EventProbeRow, FunnelResult } from "@/lib/funnel";

export const dynamic = "force-dynamic";

/** 漏斗属于延迟处理的分析报表：缓存 1 小时，手动刷新跳过读取 */
const CACHE_TTL_SECONDS = 3600;

/** 漏斗步骤事件（用于采集链路诊断） */
const FUNNEL_STEP_EVENTS = [
  "login_start",
  "login",
  "view_item",
  "checkout_click",
  "begin_checkout",
  "purchase",
];

function parseRange(value: string | null): string {
  return value && value in FUNNEL_RANGES ? value : DEFAULT_FUNNEL_RANGE;
}

/**
 * 单站点漏斗报表：?funnel=login|purchase&range=28d&breakdown=deviceCategory
 * 按站点 + 日期 + 漏斗配置 + 拆分维度缓存；?refresh=1 跳过缓存读取。
 * 响应附带采集链路诊断（各步骤事件近 28 天是否有数据），
 * 用于区分「埋点未采集」与「真实零转化」。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const { id } = await context.params;
  const url = new URL(request.url);
  const funnelId = url.searchParams.get("funnel") === "purchase" ? "purchase" : "login";
  const range = parseRange(url.searchParams.get("range"));
  const breakdownParam = url.searchParams.get("breakdown");
  const breakdown = breakdownParam === "deviceCategory" ? "deviceCategory" : null;
  const forceRefresh = url.searchParams.get("refresh") === "1";

  const loaded = await loadSitesConfig(getEnv().SITES_KV);
  const site = loaded.config.sites.find((s) => s.id === id);
  if (!site) {
    return Response.json({ error: `站点不存在：${id}` }, { status: 404 });
  }
  // 漏斗依赖站点自有的事件埋点（login_start / view_item / checkout_click 等），
  // 只有配置了 funnel 标记的站点开放查询
  if (!site.funnel) {
    return Response.json(
      { error: `站点「${site.name}」未启用转化漏斗：该站点的 GA4 埋点不包含漏斗事件。` },
      { status: 400 },
    );
  }
  const spec = findFunnel(funnelId);
  if (!spec) {
    return Response.json({ error: `未知漏斗：${funnelId}` }, { status: 400 });
  }

  const cred = getCredential();
  const cacheKey = `funnel:v1:${site.id}:${funnelId}:${range}:${breakdown ?? "total"}:${hashConfig(loaded.config)}`;

  const result = await getCachedJson<Omit<FunnelResult, "fetchedAt"> & { eventProbe?: EventProbeRow[] }>(
    cacheKey,
    CACHE_TTL_SECONDS,
    async () => {
      if (!cred.ok) {
        const empty = await emptyResult(site.id, spec.id, range);
        empty.error = { code: cred.code, message: cred.message };
        return empty;
      }
      // 漏斗主体 + 采集链路诊断（并行；诊断失败不阻塞漏斗）
      const [funnel, probe] = await Promise.all([
        fetchSiteFunnel(cred.cred, site, spec, range, breakdown),
        probeEventAvailability(cred.cred, site).catch(() => [] as EventProbeRow[]),
      ]);
      return { ...funnel, eventProbe: probe };
    },
    { forceRefresh },
  );

  return Response.json(
    { fetchedAt: result.cachedAt, ...result.data },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Cache": result.fromCache ? "HIT" : "MISS",
      },
    },
  );
}

async function emptyResult(siteId: string, funnelId: string, range: string) {
  const spec = findFunnel(funnelId);
  const days = FUNNEL_RANGES[range] ?? FUNNEL_RANGES[DEFAULT_FUNNEL_RANGE];
  const tz = "Asia/Shanghai";
  const now = new Date();
  return {
    siteId,
    funnelId,
    startDate: zonedDate(-(days - 1), tz, now),
    endDate: zonedDate(0, tz, now),
    includesToday: true,
    steps: spec?.steps.map((s, i) => ({
      step: i + 1,
      label: s.label,
      users: 0,
      stepRate: null,
      dropped: 0,
      dropRate: null,
      criteria: "",
    })) ?? [],
    overallRate: null,
    breakdownDimension: null,
    breakdowns: [],
    dataQuality: { sampled: false },
    funnelDescription: spec?.description ?? "",
    exclusionNote: "",
  } as Omit<FunnelResult, "fetchedAt">;
}

/**
 * 采集链路诊断：各步骤事件近 28 天的用户数/次数。
 * 前端用它区分「事件没有任何数据（埋点/投递未上线）」与「事件有数据但
 * 漏斗为 0（真实零转化或过滤口径不匹配）」。
 */
async function probeEventAvailability(
  cred: { client_email: string; private_key: string },
  site: { propertyId: string; timeZone?: string },
): Promise<EventProbeRow[]> {
  const tz = site.timeZone?.trim() || "Asia/Shanghai";
  const report = await runReport(cred as never, site.propertyId, {
    dateRanges: [{ startDate: zonedDate(-27, tz), endDate: zonedDate(0, tz) }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "totalUsers" }, { name: "eventCount" }],
    dimensionFilter: {
      filter: { fieldName: "eventName", inListFilter: { values: FUNNEL_STEP_EVENTS } },
    },
    limit: 100,
  });
  const byEvent = new Map<string, { users: number; count: number }>();
  for (const row of report.rows ?? []) {
    const name = row.dimensionValues?.[0]?.value ?? "";
    byEvent.set(name, {
      users: Number(row.metricValues?.[0]?.value ?? 0),
      count: Number(row.metricValues?.[1]?.value ?? 0),
    });
  }
  return FUNNEL_STEP_EVENTS.map((name) => {
    const hit = byEvent.get(name);
    return { eventName: name, users: hit?.users ?? 0, count: hit?.count ?? 0, inFunnel: true };
  });
}
