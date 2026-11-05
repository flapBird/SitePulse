import { getEnv } from "@/lib/env";
import { requireSession } from "@/lib/guards";
import {
  loadSitesConfig,
  normalizeSiteInput,
  parseSitesConfig,
  saveSitesConfig,
  slugifySiteId,
} from "@/lib/sites";
import type { SitesConfig, SitesResponse, SiteConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 站点清单（管理界面用）：GET 返回配置与来源 */
export async function GET(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const loaded = await loadSitesConfig(getEnv().SITES_KV);
  const body: SitesResponse = {
    source: loaded.source,
    kvAvailable: loaded.kvAvailable,
    kvWarning: loaded.kvWarning,
    anomalyThreshold: loaded.config.anomalyThreshold,
    sites: loaded.config.sites,
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

interface CreateSiteBody {
  name?: string;
  url?: string;
  propertyId?: string;
  timeZone?: string;
  note?: string;
  funnel?: boolean;
}

/** 新增站点（写入 KV） */
export async function POST(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const env = getEnv();
  const loaded = await loadSitesConfig(env.SITES_KV);
  if (!loaded.kvAvailable || !env.SITES_KV) {
    return Response.json(
      { error: "未绑定 SITES_KV，无法在线管理站点。请按 docs/DEPLOYMENT.md 创建并绑定 KV 命名空间。" },
      { status: 501 },
    );
  }

  let body: CreateSiteBody;
  try {
    body = (await request.json()) as CreateSiteBody;
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }

  const input = normalizeSiteInput(body);
  if (!input.name || !input.url || !input.propertyId) {
    return Response.json({ error: "名称、站点地址、Property ID 均必填" }, { status: 400 });
  }

  const sites = [...loaded.config.sites];
  const id = slugifySiteId(
    input.name,
    input.url,
    sites.map((s) => s.id),
  );
  const site: SiteConfig = {
    id,
    name: input.name,
    url: input.url,
    propertyId: input.propertyId,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.funnel != null ? { funnel: input.funnel } : {}),
  };
  // 单站点字段校验（复用整体 schema 的站点部分）
  const parse = parseSitesConfig({ version: 1, anomalyThreshold: loaded.config.anomalyThreshold, sites: [site] });
  if (parse.sites.length !== 1) {
    return Response.json({ error: "站点数据校验失败" }, { status: 400 });
  }

  const nextConfig: SitesConfig = {
    version: 1,
    anomalyThreshold: loaded.config.anomalyThreshold,
    sites: [...sites, parse.sites[0]],
  };
  try {
    await saveSitesConfig(env.SITES_KV, nextConfig);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "保存站点配置失败" },
      { status: 400 },
    );
  }
  return Response.json({ ok: true, site: parse.sites[0] }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
