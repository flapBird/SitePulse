import { getEnv } from "@/lib/env";
import { requireSession } from "@/lib/guards";
import {
  loadSitesConfig,
  normalizeSiteInput,
  parseSitesConfig,
  saveSitesConfig,
} from "@/lib/sites";
import type { SitesConfig, SiteConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function requireKv(): { kv: NonNullable<Awaited<ReturnType<typeof getEnv>>["SITES_KV"]> } | Response {
  const env = getEnv();
  if (!env.SITES_KV) {
    return Response.json(
      { error: "未绑定 SITES_KV，无法在线管理站点。请按 docs/DEPLOYMENT.md 创建并绑定 KV 命名空间。" },
      { status: 501 },
    );
  }
  return { kv: env.SITES_KV };
}

function findSite(sites: SiteConfig[], id: string): SiteConfig | undefined {
  return sites.find((s) => s.id === id);
}

/** 修改站点（写入 KV） */
export async function PUT(request: Request, context: RouteContext) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const kvOrRes = requireKv();
  if (kvOrRes instanceof Response) return kvOrRes;

  const { id } = await context.params;
  const loaded = await loadSitesConfig(kvOrRes.kv);
  const existing = findSite(loaded.config.sites, id);
  if (!existing) {
    return Response.json({ error: `站点不存在：${id}` }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }

  // 未提供的字段沿用原值
  const merged = normalizeSiteInput({
    name: typeof body.name === "string" ? body.name : existing.name,
    url: typeof body.url === "string" ? body.url : existing.url,
    propertyId: typeof body.propertyId === "string" ? body.propertyId : existing.propertyId,
    timeZone: typeof body.timeZone === "string" ? body.timeZone : (existing.timeZone ?? ""),
    note: typeof body.note === "string" ? body.note : (existing.note ?? ""),
  });
  const updated: SiteConfig = {
    id: existing.id, // id 不可变，作为关联键
    name: merged.name ?? existing.name,
    url: merged.url ?? existing.url,
    propertyId: merged.propertyId ?? existing.propertyId,
    ...(merged.timeZone ? { timeZone: merged.timeZone } : {}),
    ...(merged.note ? { note: merged.note } : {}),
  };

  const validated = parseSitesConfig({
    version: 1,
    anomalyThreshold: loaded.config.anomalyThreshold,
    sites: [updated],
  }).sites[0];

  const nextConfig: SitesConfig = {
    version: 1,
    anomalyThreshold: loaded.config.anomalyThreshold,
    sites: loaded.config.sites.map((s) => (s.id === id ? validated : s)),
  };
  try {
    await saveSitesConfig(kvOrRes.kv, nextConfig);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "保存失败" }, { status: 400 });
  }
  return Response.json({ ok: true, site: validated }, { headers: { "Cache-Control": "no-store" } });
}

/** 删除站点（写入 KV） */
export async function DELETE(request: Request, context: RouteContext) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const kvOrRes = requireKv();
  if (kvOrRes instanceof Response) return kvOrRes;

  const { id } = await context.params;
  const loaded = await loadSitesConfig(kvOrRes.kv);
  if (!findSite(loaded.config.sites, id)) {
    return Response.json({ error: `站点不存在：${id}` }, { status: 404 });
  }

  const nextConfig: SitesConfig = {
    version: 1,
    anomalyThreshold: loaded.config.anomalyThreshold,
    sites: loaded.config.sites.filter((s) => s.id !== id),
  };
  await saveSitesConfig(kvOrRes.kv, nextConfig);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
