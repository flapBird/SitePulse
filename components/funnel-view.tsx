"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, ErrorChip, RangeTabs, StateHint } from "@/components/ui";
import { getJson } from "@/lib/client";
import { formatNumber, formatTime } from "@/lib/format";
import type { EventProbeRow, FunnelResult } from "@/lib/funnel";
import type { SiteConfig } from "@/lib/types";

const RANGE_OPTIONS = [
  { value: "7d", label: "近 7 天" },
  { value: "14d", label: "近 14 天" },
  { value: "28d", label: "近 28 天" },
  { value: "90d", label: "近 90 天" },
] as const;

const FUNNEL_OPTIONS = [
  { value: "login", label: "登录漏斗" },
  { value: "purchase", label: "购买漏斗" },
] as const;

type FunnelId = (typeof FUNNEL_OPTIONS)[number]["value"];
type RangeId = (typeof RANGE_OPTIONS)[number]["value"];

/** 百分比：null → "—"（分母为零或不可计算） */
function pct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

interface FunnelResponse extends FunnelResult {
  eventProbe?: EventProbeRow[];
}

// ---------------------------------------------------------------------------
// 漏斗图（纯 SVG，横向条形递减）
// ---------------------------------------------------------------------------

function FunnelBars({ result }: { result: FunnelResult }) {
  const max = Math.max(...result.steps.map((s) => s.users), 1);
  const colors = ["#6366f1", "#818cf8", "#a5b4fc", "#c7d2fe", "#ddd6fe", "#e0e7ff"];
  if (result.steps.length === 0 || result.steps.every((s) => s.users === 0)) {
    return (
      <div className="py-10 text-center text-sm text-slate-400 dark:text-zinc-500">
        所选范围内没有用户进入该漏斗
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {result.steps.map((step, i) => {
        const width = Math.max((step.users / max) * 100, 2);
        const color = colors[i % colors.length];
        return (
          <div key={step.step}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-slate-700 dark:text-zinc-200">
                {step.step}. {step.label}
              </span>
              <span className="tnum text-slate-500 dark:text-zinc-400">
                {formatNumber(step.users)} 人
                {i > 0 && (
                  <span className="ml-2 text-xs">
                    转化率 {pct(step.stepRate)}
                    {step.dropRate != null && (
                      <span className="ml-1 text-rose-500 dark:text-rose-400">
                        （流失 {formatNumber(step.dropped)} 人 / {pct(step.dropRate)}）
                      </span>
                    )}
                  </span>
                )}
              </span>
            </div>
            <div className="h-8 overflow-hidden rounded-lg bg-slate-100 dark:bg-zinc-800/70">
              <div
                className="flex h-full items-center justify-end rounded-lg pr-2 transition-all"
                style={{ width: `${width}%`, backgroundColor: color }}
                title={`${step.label}：${step.users} 人`}
              >
                {step.users > 0 && width > 12 && (
                  <span className="text-xs font-medium text-white tnum">{formatNumber(step.users)}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <div className="pt-1 text-sm text-slate-500 dark:text-zinc-400">
        总体转化率（首步 → 末步）：
        <span className="ml-1 font-semibold text-slate-700 tnum dark:text-zinc-200">
          {pct(result.overallRate)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 步骤明细表
// ---------------------------------------------------------------------------

function StepTable({ steps }: { steps: FunnelResult["steps"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800 dark:text-zinc-500">
            <th className="py-2 pr-3 font-medium">步骤</th>
            <th className="py-2 pr-3 font-medium">口径（事件 · 参数 · 窗口）</th>
            <th className="py-2 pr-3 text-right font-medium">人数</th>
            <th className="py-2 pr-3 text-right font-medium">上一步转化率</th>
            <th className="py-2 pr-3 text-right font-medium">流失人数</th>
            <th className="py-2 text-right font-medium">流失率</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.step} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/60">
              <td className="py-2 pr-3 align-top">
                <div className="font-medium text-slate-700 dark:text-zinc-200">
                  {step.step}. {step.label}
                </div>
              </td>
              <td className="max-w-[22rem] py-2 pr-3 align-top text-xs text-slate-400 dark:text-zinc-500">
                {step.criteria || "—"}
              </td>
              <td className="py-2 pr-3 text-right align-top tnum">{formatNumber(step.users)}</td>
              <td className="py-2 pr-3 text-right align-top tnum">
                {step.step === 1 ? "（首步）" : pct(step.stepRate)}
              </td>
              <td className="py-2 pr-3 text-right align-top tnum">
                {step.step === 1 ? "—" : formatNumber(step.dropped)}
              </td>
              <td className="py-2 text-right align-top tnum">{step.step === 1 ? "—" : pct(step.dropRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 设备拆分表
// ---------------------------------------------------------------------------

const DEVICE_LABELS: Record<string, string> = {
  desktop: "桌面",
  mobile: "移动",
  tablet: "平板",
};

function BreakdownTable({ result }: { result: FunnelResult }) {
  if (result.breakdowns.length === 0) {
    return <div className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">暂无拆分数据</div>;
  }
  const stepLabels = result.steps.map((s) => `${s.step}. ${s.label}`);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs text-slate-400 dark:border-zinc-800 dark:text-zinc-500">
            <th className="py-2 pr-3 font-medium">设备</th>
            {result.steps.map((s) => (
              <th key={s.step} className="py-2 pr-3 text-right font-medium">
                {s.step}. {s.label}
              </th>
            ))}
            <th className="py-2 text-right font-medium">总体转化率</th>
          </tr>
        </thead>
        <tbody>
          {result.breakdowns.map((group) => (
            <tr key={group.key} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/60">
              <td className="py-2 pr-3 font-medium text-slate-700 dark:text-zinc-200">
                {DEVICE_LABELS[group.key] ?? group.key}
              </td>
              {group.steps.map((s) => (
                <td key={s.step} className="py-2 pr-3 text-right tnum">
                  {formatNumber(s.users)}
                  {s.step > 1 && (
                    <span className="block text-xs text-slate-400 dark:text-zinc-500">{pct(s.stepRate)}</span>
                  )}
                </td>
              ))}
              <td className="py-2 text-right font-medium tnum">{pct(group.overallRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-400 dark:text-zinc-500">
        每列上方为到达人数，下方为自上一步的转化率；各设备组独立计算，与总计行口径一致。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 采集链路诊断
// ---------------------------------------------------------------------------

function EventProbeHint({ probe, funnelId }: { probe: EventProbeRow[]; funnelId: FunnelId }) {
  const relevant =
    funnelId === "purchase"
      ? probe.filter((p) => ["view_item", "checkout_click", "begin_checkout", "purchase"].includes(p.eventName))
      : probe.filter((p) => ["login_start", "login"].includes(p.eventName));
  const missing = relevant.filter((p) => p.count === 0);
  if (missing.length === 0) return null;
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
      ⚠️ 以下漏斗步骤事件在近 28 天内没有任何数据（埋点未采集或投递链路未上线），人数为 0
      不代表用户全部流失：
      {missing.map((m) => (
        <span key={m.eventName} className="ml-1 font-mono">
          {m.eventName}
        </span>
      ))}
      {missing.some((m) => m.eventName === "begin_checkout" || m.eventName === "purchase") && (
        <span className="block">
          服务端 begin_checkout / purchase 依赖数据库迁移、Measurement Protocol 运行时配置与定时发送任务，请先排查网站侧采集链路是否已上线并正常投递。
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------

export function FunnelView({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [funnelId, setFunnelId] = useState<FunnelId>("login");
  const [range, setRange] = useState<RangeId>("28d");
  const [breakdown, setBreakdown] = useState<"none" | "deviceCategory">("deviceCategory");
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const sites = await getJson<{ sites: SiteConfig[] }>("/api/sites").catch(() => null);
      if (sites) setSite(sites.sites.find((s) => s.id === siteId) ?? null);
    })();
  }, [siteId]);

  const load = useCallback(
    async (force: boolean) => {
      try {
        const res = await getJson<FunnelResponse>(`/api/sites/${siteId}/funnel`, {
          funnel: funnelId,
          range,
          breakdown: breakdown === "deviceCategory" ? "deviceCategory" : undefined,
          refresh: force ? "1" : undefined,
        });
        setData(res);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [siteId, funnelId, range, breakdown],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load(false).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const dataNote = useMemo(() => {
    if (!data) return null;
    const notes: string[] = [];
    if (data.includesToday) {
      notes.push("当天数据为暂定（GA4 处理延迟，通常数小时）");
      notes.push("临近日期范围结束的长窗口转化可能尚未完成");
    }
    return notes.length > 0 ? notes.join("；") : null;
  }, [data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <a href="/" className="text-sm text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400">
              概览
            </a>
            <span className="text-slate-300 dark:text-zinc-600">/</span>
            <a
              href={`/sites/${siteId}`}
              className="text-sm text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400"
            >
              {site?.name ?? siteId}
            </a>
            <span className="text-slate-300 dark:text-zinc-600">/</span>
            <h1 className="text-xl font-semibold tracking-tight">转化漏斗</h1>
          </div>
          {site && (
            <p className="mt-0.5 text-xs text-slate-400 dark:text-zinc-500">
              {site.url} · Property {site.propertyId}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data && !data.error && (
            <span className="text-xs text-slate-400 dark:text-zinc-500">更新于 {formatTime(data.fetchedAt)}</span>
          )}
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void load(true).finally(() => setRefreshing(false));
            }}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>⟳</span>
            刷新
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <RangeTabs value={funnelId} onChange={setFunnelId} options={[...FUNNEL_OPTIONS]} />
        <RangeTabs value={range} onChange={setRange} options={[...RANGE_OPTIONS]} />
        <RangeTabs
          value={breakdown}
          onChange={(v) => setBreakdown(v)}
          options={[
            { value: "none" as const, label: "整体" },
            { value: "deviceCategory" as const, label: "按设备" },
          ]}
        />
        {data?.error && <ErrorChip error={data.error} />}
      </div>

      <StateHint loading={loading && !data} error={error} />

      {data && !data.error && (
        <>
          {data.eventProbe && <EventProbeHint probe={data.eventProbe} funnelId={funnelId} />}

          <Card title={data.funnelId === "purchase" ? "购买漏斗 · 整体" : "登录漏斗 · 整体"}>
            <FunnelBars result={data} />
            {data.dataQuality.sampled && (
              <p className="mt-3 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                {data.dataQuality.samplingNote}
              </p>
            )}
            {dataNote && (
              <p className="mt-2 text-xs text-slate-400 dark:text-zinc-500">⏳ {dataNote}</p>
            )}
          </Card>

          <Card title="步骤明细">
            <StepTable steps={data.steps} />
          </Card>

          {data.breakdownDimension === "deviceCategory" && (
            <Card title="按设备类别拆分">
              <BreakdownTable result={data} />
            </Card>
          )}

          <Card title="漏斗规则与口径">
            <div className="space-y-2 text-xs leading-relaxed text-slate-500 dark:text-zinc-400">
              <p>
                <span className="font-medium text-slate-600 dark:text-zinc-300">规则：</span>
                {data.funnelDescription}
              </p>
              <p>
                <span className="font-medium text-slate-600 dark:text-zinc-300">内部用户排除：</span>
                {data.exclusionNote}
              </p>
              <p>
                <span className="font-medium text-slate-600 dark:text-zinc-300">计算口径：</span>
                封闭漏斗（用户必须从第一步进入）；相邻步骤转化率 = 当前步人数 / 上一步人数（漏斗内同一口径的去重用户）；总体转化率
                = 末步人数 / 首步人数；分母为 0 时显示「—」。日期范围 {data.startDate} ~ {data.endDate}
                （站点时区），周期整体重新查询，不是每日数据的加总或平均。
              </p>
              <p>
                <span className="font-medium text-slate-600 dark:text-zinc-300">数据源与限制：</span>
                GA4 用户行为分析报表，存在处理延迟与报告身份差异，不能作为付款实时告警依据；实际订单数、收入、退款与财务核对应以业务数据库及支付平台为准（purchase
                不代表扣除退款后的净收入）。国家、来源/媒介拆分待确认漏斗 API 支持情况后再加入。
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
