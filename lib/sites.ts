/**
 * 站点配置解析与持久化。
 *
 * 数据源优先级：Workers KV（SITES_KV，管理界面写入）> config/sites.json（种子文件）。
 * KV 数据非法时自动回退种子文件并给出警告。纯 KV/JSON 操作，可单元测试。
 */

import seedConfig from "../config/sites.json";
import { z } from "zod";
import { isValidTimeZone } from "./datetime";
import type { LoadedSitesConfig, SiteConfig, SitesConfig } from "./types";

/** KV 中存储站点配置的键 */
export const SITES_KV_KEY = "sites";

export const DEFAULT_ANOMALY_THRESHOLD = 0.3;
/** 默认报告时区：需与 GA4 Property 的报告时区一致 */
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

const SiteSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id 只能包含小写字母、数字和连字符，且以字母或数字开头"),
  name: z.string().min(1, "名称不能为空").max(100),
  url: z.string().url("站点地址必须是合法 URL（含 https://）"),
  propertyId: z.string().regex(/^\d{4,}$/, "GA4 Property ID 必须是纯数字（可在 GA4 后台 → 属性设置中找到）"),
  timeZone: z
    .string()
    .max(64)
    .refine((tz) => isValidTimeZone(tz), "时区格式不正确，应为 IANA 时区名（如 Asia/Shanghai）")
    .optional(),
  note: z.string().max(200).optional(),
});

const SitesConfigSchema = z.object({
  version: z.literal(1),
  anomalyThreshold: z.number().min(0.05).max(1),
  sites: z.array(SiteSchema).max(200),
});

export function parseSitesConfig(raw: unknown): SitesConfig {
  const result = SitesConfigSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.length ? `${first.path.map(String).join(".")}: ` : "";
    throw new Error(`${path}${first?.message ?? "配置格式不正确"}`);
  }
  return result.data;
}

/** 种子配置（构建时打进 Worker） */
export function seedSites(): SitesConfig {
  try {
    return parseSitesConfig(seedConfig);
  } catch {
    // 种子文件损坏不应导致整个应用不可用
    return { version: 1, anomalyThreshold: DEFAULT_ANOMALY_THRESHOLD, sites: [] };
  }
}

export interface KvLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 加载站点配置：KV 优先，其次种子文件 */
export async function loadSitesConfig(kv?: KvLike): Promise<LoadedSitesConfig> {
  const seed = seedSites();
  if (!kv) {
    return { config: seed, source: "file", kvAvailable: false };
  }

  let raw: unknown;
  try {
    raw = await kv.get(SITES_KV_KEY, "json");
  } catch (err) {
    return {
      config: seed,
      source: "file",
      kvAvailable: true,
      kvWarning: `读取 KV 失败，已回退到种子配置：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (raw == null) {
    // KV 还没有任何数据：视为尚未在管理界面保存过，用种子
    return { config: seed, source: "file", kvAvailable: true };
  }

  try {
    return { config: parseSitesConfig(raw), source: "kv", kvAvailable: true };
  } catch (err) {
    return {
      config: seed,
      source: "file",
      kvAvailable: true,
      kvWarning: `KV 中的站点配置不合法（${err instanceof Error ? err.message : String(err)}），已回退到种子配置`,
    };
  }
}

/** 保存站点配置到 KV（抛错由路由层转成响应） */
export async function saveSitesConfig(kv: KvLike, config: SitesConfig): Promise<void> {
  // 写入前再校验一遍，避免把非法数据写进 KV
  parseSitesConfig(config);
  await kv.put(SITES_KV_KEY, JSON.stringify(config));
}

/** 由 URL/名称生成唯一的站点 id（slug），冲突时追加序号。URL 优先（中文名称没有 ASCII slug） */
export function slugifySiteId(name: string, url: string, existingIds: string[] = []): string {
  const source = (url || name).toLowerCase();
  const base =
    source
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "site";
  let id = base;
  let counter = 2;
  const taken = new Set(existingIds);
  while (taken.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  return id;
}

/** 归一化一个站点输入：去掉首尾空白、URL 补协议、Property ID 去前缀 */
export function normalizeSiteInput(input: Partial<SiteConfig>): Partial<SiteConfig> {
  const out: Partial<SiteConfig> = {};
  if (typeof input.id === "string") out.id = input.id.trim();
  if (typeof input.name === "string") out.name = input.name.trim();
  if (typeof input.note === "string") {
    const note = input.note.trim();
    if (note) out.note = note;
  }
  if (typeof input.url === "string") {
    let url = input.url.trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    out.url = url.replace(/\/+$/, "");
  }
  if (typeof input.propertyId === "string") {
    out.propertyId = input.propertyId.trim().replace(/^properties\//, "");
  }
  if (typeof input.timeZone === "string") {
    const tz = input.timeZone.trim();
    if (tz) out.timeZone = tz;
  }
  return out;
}

/** 站点时区的缺省值兜底 */
export function siteTimeZone(site: Pick<SiteConfig, "timeZone">): string {
  return site.timeZone?.trim() || DEFAULT_TIME_ZONE;
}

/** FNV-1a 短哈希：用于把配置内容并入缓存键（配置变更后自动换新键） */
export function hashConfig(config: SitesConfig): string {
  const json = JSON.stringify(config);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
