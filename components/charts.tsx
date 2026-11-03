"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useState } from "react";

/** 读取当前暗色状态（与 ThemeToggle 的 dark class 约定一致），用于图表配色 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const update = () => setDark(document.documentElement.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

const PALETTE = {
  users: "#6366f1", // indigo-500：UV
  pageviews: "#10b981", // emerald-500：PV
  gridLight: "#e2e8f0",
  gridDark: "#27272a",
};

/** 通用 tooltip 样式（随主题切换） */
function tooltipStyle(dark: boolean): React.CSSProperties {
  return {
    background: dark ? "rgba(24, 24, 27, 0.95)" : "rgba(255, 255, 255, 0.97)",
    border: `1px solid ${dark ? "#3f3f46" : "#e2e8f0"}`,
    borderRadius: 8,
    fontSize: 12,
    color: dark ? "#e4e4e7" : "#0f172a",
  };
}

export interface TrendDatum {
  /** X 轴标签 */
  label: string;
  users: number;
  pageviews: number;
}

/** 历史趋势双线图（UV/PV） */
export function HistoryTrendChart({ data, height = 260 }: { data: TrendDatum[]; height?: number }) {
  const dark = useIsDark();
  if (data.length === 0) {
    return <div className="py-10 text-center text-sm text-slate-400 dark:text-zinc-500">暂无趋势数据</div>;
  }
  return (
    <div className="text-slate-400 dark:text-zinc-500" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={dark ? PALETTE.gridDark : PALETTE.gridLight} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
          <Tooltip contentStyle={tooltipStyle(dark)} />
          <Line
            type="monotone"
            dataKey="pageviews"
            name="PV"
            stroke={PALETTE.pageviews}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="users"
            name="UV"
            stroke={PALETTE.users}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 全站实时分钟趋势（面积图） */
export function MinuteTrendChart({ data, height = 200 }: { data: TrendDatum[]; height?: number }) {
  const dark = useIsDark();
  if (data.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-400 dark:text-zinc-500">暂无实时数据</div>;
  }
  return (
    <div className="text-slate-400 dark:text-zinc-500" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="minuteFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PALETTE.users} stopOpacity={0.35} />
              <stop offset="100%" stopColor={PALETTE.users} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={dark ? PALETTE.gridDark : PALETTE.gridLight} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={32} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle(dark)} />
          <Area
            type="monotone"
            dataKey="users"
            name="活跃用户"
            stroke={PALETTE.users}
            strokeWidth={2}
            fill="url(#minuteFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 迷你趋势线（表格内嵌，无依赖的手绘 SVG） */
export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) {
    return <span className="text-xs text-slate-300 dark:text-zinc-600">—</span>;
  }
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#10b981" : last < first ? "#f43f5e" : "#6366f1";
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
