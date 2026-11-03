/**
 * 并发控制工具：Promise.allSettled 的限流版本。
 * 多站点并发请求 GA4 时限制同时在途的请求数，避免一次刷新打爆配额或连接数。
 */

export async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
): Promise<PromiseSettledResult<TOut>[]> {
  const results: PromiseSettledResult<TOut>[] = new Array(items.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length));

  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (err) {
        results[index] = { status: "rejected", reason: err };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runNext()));
  return results;
}

/** 把 PromiseSettledResult 数组转成 (value | undefined)[]，丢弃失败项（错误由 worker 内部捕获进结果对象） */
export function settledValues<T>(settled: PromiseSettledResult<T>[]): (T | undefined)[] {
  return settled.map((s) => (s.status === "fulfilled" ? s.value : undefined));
}
