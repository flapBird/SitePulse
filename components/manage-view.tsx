"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, ErrorChip, StateHint } from "@/components/ui";
import { deleteJson, getJson, postJson, putJson } from "@/lib/client";
import type { SiteConfig, SitesResponse } from "@/lib/types";

const TIME_ZONE_OPTIONS = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Europe/London",
  "Europe/Berlin",
  "America/Los_Angeles",
  "America/New_York",
  "UTC",
];

interface FormState {
  id?: string; // 存在 = 编辑模式
  name: string;
  url: string;
  propertyId: string;
  timeZone: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  url: "",
  propertyId: "",
  timeZone: "Asia/Shanghai",
  note: "",
};

export function ManageView() {
  const [data, setData] = useState<SitesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getJson<SitesResponse>("/api/sites");
      setData(res);
      setMessage(null);
    } catch (err) {
      setMessage({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setMessage(null);
      try {
        const body = {
          name: form.name,
          url: form.url,
          propertyId: form.propertyId,
          timeZone: form.timeZone,
          note: form.note,
        };
        if (editing && form.id) {
          await putJson(`/api/sites/${form.id}`, body);
          setMessage({ kind: "ok", text: `已更新「${form.name}」` });
        } else {
          await postJson("/api/sites", body);
          setMessage({ kind: "ok", text: `已添加「${form.name}」` });
        }
        setForm(EMPTY_FORM);
        setEditing(false);
        await load();
      } catch (err) {
        setMessage({ kind: "err", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setSubmitting(false);
      }
    },
    [editing, form, load],
  );

  const startEdit = (site: SiteConfig) => {
    setEditing(true);
    setForm({
      id: site.id,
      name: site.name,
      url: site.url,
      propertyId: site.propertyId,
      timeZone: site.timeZone ?? "Asia/Shanghai",
      note: site.note ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (site: SiteConfig) => {
    if (!window.confirm(`确定删除「${site.name}」（${site.propertyId}）吗？此操作会立即生效。`)) return;
    try {
      await deleteJson(`/api/sites/${site.id}`);
      setMessage({ kind: "ok", text: `已删除「${site.name}」` });
      if (editing && form.id === site.id) {
        setEditing(false);
        setForm(EMPTY_FORM);
      }
      await load();
    } catch (err) {
      setMessage({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const kvUnavailable = data != null && !data.kvAvailable;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">站点管理</h1>
        <p className="mt-0.5 text-xs text-slate-400 dark:text-zinc-500">
          新增 / 修改 / 删除会写入 Workers KV 并立即生效（无需重新部署）；config/sites.json 仅作为初始种子。
        </p>
      </div>

      {kvUnavailable && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
          ⚠️ 未绑定 SITES_KV，在线管理不可用：当前展示的是种子文件配置（只读）。请按 docs/DEPLOYMENT.md 创建 KV
          命名空间并在 cloudflare.config.ts 中绑定。
        </div>
      )}
      {data && data.kvAvailable && data.source === "file" && !data.kvWarning && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-400">
          ℹ️ 当前展示种子文件中的站点。首次在界面保存后，KV 将成为唯一数据源（包含种子站点，可继续增删改）。
        </div>
      )}
      {data?.kvWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
          ⚠️ {data.kvWarning}
        </div>
      )}
      {message && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${
            message.kind === "ok"
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
              : "border border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-400"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-5">
        {/* 表单 */}
        <Card className="xl:col-span-2" title={editing ? `编辑站点：${form.id}` : "新增站点"}>
          <form onSubmit={(e) => void onSubmit(e)} className="space-y-3.5">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-zinc-400">站点名称 *</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="如：我的博客"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-zinc-400">站点地址 *</span>
              <input
                required
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://example.com"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-zinc-400">
                GA4 Property ID *（纯数字）
              </span>
              <input
                required
                value={form.propertyId}
                onChange={(e) => setForm((f) => ({ ...f, propertyId: e.target.value }))}
                placeholder="如：123456789"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-zinc-400">
                报告时区（与 GA4 Property 一致）
              </span>
              <select
                value={form.timeZone}
                onChange={(e) => setForm((f) => ({ ...f, timeZone: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {TIME_ZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-zinc-400">备注</span>
              <input
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="可选"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={submitting || kvUnavailable}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {submitting ? "保存中…" : editing ? "保存修改" : "添加站点"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setForm(EMPTY_FORM);
                  }}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  取消
                </button>
              )}
            </div>
          </form>
        </Card>

        {/* 列表 */}
        <Card className="xl:col-span-3" title={`站点列表（${data?.sites.length ?? 0}）`}>
          <StateHint loading={loading} empty="还没有站点，先用左侧表单添加一个。" />
          {data && data.sites.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-zinc-800">
              {data.sites.map((site) => (
                <li key={site.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/sites/${site.id}`}
                      className="font-medium text-slate-800 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                    >
                      {site.name}
                    </a>
                    <div className="truncate text-xs text-slate-400 dark:text-zinc-500">
                      {site.url} · Property {site.propertyId}
                      {site.timeZone ? ` · ${site.timeZone}` : ""}
                      {site.note ? ` · ${site.note}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => startEdit(site)}
                    disabled={kvUnavailable}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(site)}
                    disabled={kvUnavailable}
                    className="rounded-md border border-rose-200 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data && <div className="mt-3 text-xs text-slate-400 dark:text-zinc-500">数据来源：{data.source === "kv" ? "Workers KV" : "config/sites.json（种子）"}</div>}
        </Card>
      </div>
    </div>
  );
}
