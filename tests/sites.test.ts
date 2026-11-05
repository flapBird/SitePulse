import { describe, expect, it } from "vitest";
import {
  loadSitesConfig,
  normalizeSiteInput,
  parseSitesConfig,
  seedSites,
  siteTimeZone,
  slugifySiteId,
} from "../lib/sites";

describe("parseSitesConfig", () => {
  it("接受合法配置", () => {
    const config = parseSitesConfig({
      version: 1,
      anomalyThreshold: 0.3,
      sites: [{ id: "a", name: "A", url: "https://a.com", propertyId: "123456" }],
    });
    expect(config.sites).toHaveLength(1);
  });

  it("拒绝非法 Property ID / URL / 时区", () => {
    expect(() =>
      parseSitesConfig({
        version: 1,
        anomalyThreshold: 0.3,
        sites: [{ id: "a", name: "A", url: "https://a.com", propertyId: "abc" }],
      }),
    ).toThrow(/纯数字/);

    expect(() =>
      parseSitesConfig({
        version: 1,
        anomalyThreshold: 0.3,
        sites: [{ id: "a", name: "A", url: "not-a-url", propertyId: "123456" }],
      }),
    ).toThrow(/URL/);

    expect(() =>
      parseSitesConfig({
        version: 1,
        anomalyThreshold: 0.3,
        sites: [{ id: "a", name: "A", url: "https://a.com", propertyId: "123456", timeZone: "Mars/Olympus" }],
      }),
    ).toThrow(/时区/);
  });
});

describe("seedSites", () => {
  it("读取仓库种子文件", () => {
    const seed = seedSites();
    expect(seed.version).toBe(1);
    expect(Array.isArray(seed.sites)).toBe(true);
    expect(seed.anomalyThreshold).toBeGreaterThan(0);
  });
});

describe("slugifySiteId", () => {
  it("从名称/URL 生成 slug 并去重", () => {
    expect(slugifySiteId("我的博客", "https://www.blog.example.com")).toBe("blog-example-com");
    // URL 优先；冲突时追加序号
    expect(slugifySiteId("Example", "https://example.com")).toBe("example-com");
    expect(slugifySiteId("Example", "https://example.com", ["example-com"])).toBe("example-com-2");
    expect(slugifySiteId("###", "https://x.com")).toBe("x-com");
    // 名称与 URL 都无法生成 slug 时兜底
    expect(slugifySiteId("###", "")).toBe("site");
  });
});

describe("normalizeSiteInput", () => {
  it("补协议、去前缀、去空白", () => {
    const out = normalizeSiteInput({
      name: " A ",
      url: "example.com/path/",
      propertyId: " properties/123456 ",
      note: " 备注 ",
      timeZone: " Asia/Tokyo ",
    });
    expect(out).toEqual({
      name: "A",
      url: "https://example.com/path",
      propertyId: "123456",
      note: "备注",
      timeZone: "Asia/Tokyo",
    });
  });

  it("保留 funnel 布尔标记；未提供时不动该字段", () => {
    expect(normalizeSiteInput({ name: "A", funnel: true }).funnel).toBe(true);
    expect(normalizeSiteInput({ name: "A", funnel: false }).funnel).toBe(false);
    expect(normalizeSiteInput({ name: "A" }).funnel).toBeUndefined();
    expect(normalizeSiteInput({ name: "A", funnel: "yes" as never }).funnel).toBeUndefined();
  });
});

describe("站点配置 funnel 标记", () => {
  it("parseSitesConfig 接受布尔 funnel；拒绝非法类型", () => {
    const ok = parseSitesConfig({
      version: 1,
      anomalyThreshold: 0.3,
      sites: [
        { id: "a", name: "A", url: "https://a.com", propertyId: "123456", funnel: true },
        { id: "b", name: "B", url: "https://b.com", propertyId: "223456" },
      ],
    });
    expect(ok.sites[0].funnel).toBe(true);
    expect(ok.sites[1].funnel).toBeUndefined();

    expect(() =>
      parseSitesConfig({
        version: 1,
        anomalyThreshold: 0.3,
        sites: [{ id: "a", name: "A", url: "https://a.com", propertyId: "123456", funnel: "true" as never }],
      }),
    ).toThrow();
  });
});

describe("loadSitesConfig", () => {
  it("无 KV 时使用种子文件", async () => {
    const loaded = await loadSitesConfig(undefined);
    expect(loaded.source).toBe("file");
    expect(loaded.kvAvailable).toBe(false);
    expect(loaded.config).toEqual(seedSites());
  });

  it("KV 为空时使用种子且标记 kvAvailable", async () => {
    const loaded = await loadSitesConfig({ get: async () => null, put: async () => {}, delete: async () => {} });
    expect(loaded.source).toBe("file");
    expect(loaded.kvAvailable).toBe(true);
  });

  it("KV 优先并做校验", async () => {
    const kvConfig = {
      version: 1,
      anomalyThreshold: 0.5,
      sites: [{ id: "kv-site", name: "KV", url: "https://kv.com", propertyId: "123456" }],
    };
    const loaded = await loadSitesConfig({
      get: async () => kvConfig,
      put: async () => {},
      delete: async () => {},
    });
    expect(loaded.source).toBe("kv");
    expect(loaded.config.anomalyThreshold).toBe(0.5);
    expect(loaded.config.sites[0].id).toBe("kv-site");
  });

  it("KV 数据非法时回退种子并给出警告", async () => {
    const loaded = await loadSitesConfig({
      get: async () => ({ version: 1, anomalyThreshold: 0.3, sites: [{ id: "BAD ID" }] }),
      put: async () => {},
      delete: async () => {},
    });
    expect(loaded.source).toBe("file");
    expect(loaded.kvWarning).toContain("不合法");
  });
});

describe("siteTimeZone", () => {
  it("缺省 Asia/Shanghai", () => {
    expect(siteTimeZone({})).toBe("Asia/Shanghai");
    expect(siteTimeZone({ timeZone: "Europe/Berlin" })).toBe("Europe/Berlin");
  });
});
