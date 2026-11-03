/**
 * 查询结果缓存：Cloudflare Cache API（caches.default）为主，内存 Map 兜底。
 *
 * - 同一 Worker 内先查内存（纳秒级），未命中再查边缘缓存（同 PoP 共享）。
 * - 都未命中才执行 loader，并把结果写回两层。
 * - forceRefresh（手动刷新）跳过读取，但仍回写，避免刷新流量打爆 GA4 配额。
 * - 纯净模块：cacheStorage 由调用方注入（Workers 传 caches.default，测试传 undefined）。
 */

interface CacheEntry<T> {
  data: T;
  /** 写入时间（ISO 字符串），用于前端展示「数据更新时间」 */
  cachedAt: string;
  expiresAt: number;
}

const memory = new Map<string, CacheEntry<unknown>>();

export interface CacheResult<T> {
  data: T;
  cachedAt: string;
  fromCache: boolean;
}

function cacheKeyUrl(key: string): string {
  // Cache API 需要绝对 URL 作为键；用固定主机名 + 编码后的键，与站点域名无关
  return `https://sitepulse.internal/__cache/${encodeURIComponent(key)}`;
}

function cacheStorage(): Cache | undefined {
  const cachesRef = (globalThis as { caches?: { default?: Cache } }).caches;
  return cachesRef?.default;
}

export async function getCachedJson<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  options: { forceRefresh?: boolean; now?: Date } = {},
): Promise<CacheResult<T>> {
  const nowMs = (options.now ?? new Date()).getTime();
  const force = options.forceRefresh === true;

  if (!force) {
    const mem = memory.get(key) as CacheEntry<T> | undefined;
    if (mem && mem.expiresAt > nowMs) {
      return { data: mem.data, cachedAt: mem.cachedAt, fromCache: true };
    }

    const storage = cacheStorage();
    if (storage) {
      try {
        const hit = await storage.match(cacheKeyUrl(key));
        if (hit) {
          const entry = (await hit.json()) as CacheEntry<T>;
          const writtenAt = Date.parse(entry.cachedAt);
          if (Number.isFinite(writtenAt) && writtenAt + ttlSeconds * 1000 > nowMs) {
            memory.set(key, { ...entry, expiresAt: writtenAt + ttlSeconds * 1000 });
            return { data: entry.data, cachedAt: entry.cachedAt, fromCache: true };
          }
        }
      } catch {
        // 边缘缓存异常不影响业务：当作未命中
      }
    }
  }

  const data = await loader();
  const cachedAt = (options.now ?? new Date()).toISOString();
  const entry: CacheEntry<T> = { data, cachedAt, expiresAt: nowMs + ttlSeconds * 1000 };
  memory.set(key, entry);

  const storage = cacheStorage();
  if (storage) {
    try {
      const res = new Response(JSON.stringify(entry), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` },
      });
      // put 需要 GET 请求对象作为键
      await storage.put(new Request(cacheKeyUrl(key), { method: "GET" }), res);
    } catch {
      // 写缓存失败不影响返回
    }
  }

  return { data, cachedAt, fromCache: false };
}

/** 清空内存缓存（测试用） */
export function clearMemoryCache(): void {
  memory.clear();
}
