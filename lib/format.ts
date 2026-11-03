/**
 * 展示层格式化工具（前后端通用，纯函数）。
 */

/** 数字：万位以上用「万」，其余按千分位 */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 10_000).toFixed(0)}万+`;
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString("zh-CN");
}

/** 变化率：0.4231 → +42.3%；null → "—" */
export function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

/** ISO 时间 → HH:mm:ss（本地时区） */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 日期（YYYY-MM-DD）→ 「M月D日」 */
export function formatDateShort(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

/** 分钟偏移 → 「-29分 / 现在」 */
export function formatMinutesAgo(minutesAgo: number): string {
  return minutesAgo === 0 ? "现在" : `-${minutesAgo}分`;
}

/** 小时 → 「14时」 */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}时`;
}
