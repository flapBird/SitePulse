import { describe, expect, it, vi } from "vitest";
import { clearMemoryCache, getCachedJson } from "../lib/cache";

describe("getCachedJson", () => {
  it("TTL 内命中缓存，loader 只执行一次", async () => {
    clearMemoryCache();
    const loader = vi.fn(async () => ({ value: 1 }));
    const first = await getCachedJson("test:k1", 60, loader);
    const second = await getCachedJson("test:k1", 60, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.cachedAt).toBe(first.cachedAt);
    expect(second.data).toEqual({ value: 1 });
  });

  it("TTL 过期后重新加载", async () => {
    clearMemoryCache();
    const loader = vi.fn(async () => ({ n: 1 }));
    const t0 = new Date("2026-01-01T00:00:00Z");
    await getCachedJson("test:k2", 60, loader, { now: t0 });
    // 61 秒后过期
    const later = await getCachedJson("test:k2", 60, loader, {
      now: new Date(t0.getTime() + 61_000),
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(later.fromCache).toBe(false);
  });

  it("forceRefresh 跳过读取并回写", async () => {
    clearMemoryCache();
    let n = 0;
    await getCachedJson("test:k3", 60, async () => ({ call: ++n }));
    const forced = await getCachedJson("test:k3", 60, async () => ({ call: ++n }), { forceRefresh: true });
    expect(forced.fromCache).toBe(false);
    expect(forced.data).toEqual({ call: 2 });
    // 回写后常规读取命中新值
    const again = await getCachedJson("test:k3", 60, async () => ({ call: ++n }));
    expect(again.fromCache).toBe(true);
    expect(again.data).toEqual({ call: 2 });
  });

  it("loader 抛错时不上缓存且异常透传", async () => {
    clearMemoryCache();
    const loader = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(getCachedJson("test:k4", 60, loader)).rejects.toThrow("boom");
    await expect(getCachedJson("test:k4", 60, loader)).rejects.toThrow("boom");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
