/**
 * 时区感知的日期工具。
 *
 * GA4 的「今日/昨日/同期」由 Property 的报告时区决定；站点配置里要求填写
 * 与 GA4 Property 一致的 IANA 时区（如 Asia/Shanghai），这里基于 Intl 在
 * Workers 运行时（完整 ICU 支持）中计算该时区下的日期与小时。
 */

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(timeZone, fmt);
  }
  return fmt;
}

/** 校验 IANA 时区名是否有效 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 把时刻换算到指定时区，取出年月日时分 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** 以「该时区当天」为基准，偏移 offsetDays 天后的日期 */
function dayCursor(parts: ZonedParts, offsetDays: number): ZonedParts {
  // 用 UTC 日历做纯日期加减（避免夏令时干扰；结果只取年月日）
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day) + offsetDays * 86_400_000;
  const d = new Date(utc);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD（指定时区下 today+offsetDays 的日期） */
export function zonedDate(offsetDays: number, timeZone: string, now: Date = new Date()): string {
  const p = dayCursor(zonedParts(now, timeZone), offsetDays);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** YYYYMMDD（GA4 date 维度的取值格式，用于匹配返回行） */
export function gaDateCompact(offsetDays: number, timeZone: string, now: Date = new Date()): string {
  return zonedDate(offsetDays, timeZone, now).replaceAll("-", "");
}

/** YYYYMMDDHH（GA4 dateHour 维度的取值格式） */
export function gaHourCompact(
  offsetDays: number,
  hour: number,
  timeZone: string,
  now: Date = new Date(),
): string {
  return `${gaDateCompact(offsetDays, timeZone, now)}${pad(hour)}`;
}

/** 指定时区下当前时刻的当天已过完整小时数（0-23；09:30 → 9） */
export function zonedElapsedHour(timeZone: string, now: Date = new Date()): number {
  return zonedParts(now, timeZone).hour;
}

/** 把 GA4 行的 date（YYYYMMDD）格式化为 YYYY-MM-DD */
export function formatGaDate(compact: string): string {
  if (compact.length !== 8) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
