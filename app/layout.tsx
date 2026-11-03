import type { Metadata } from "next";
import "./globals.css";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = {
  title: "SitePulse · GA4 多站点流量监控",
  description: "集中展示多个 GA4 Property 的实时流量与历史统计",
};

/** 防闪烁：渲染前根据 localStorage / 系统偏好设置 dark class */
const themeInitScript = `(function(){try{var t=localStorage.getItem("sp-theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;if(d)document.documentElement.classList.add("dark");}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
            <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-sm text-white">
                SP
              </span>
              SitePulse
            </a>
            <nav className="flex items-center gap-1 text-sm">
              <a
                href="/"
                className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              >
                概览
              </a>
              <a
                href="/manage"
                className="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              >
                站点管理
              </a>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-6 pb-8 text-xs text-slate-400 dark:text-zinc-600">
          SitePulse · 数据来自 Google Analytics Data API（只读）· 实时缓存 60 秒 / 历史缓存 5 分钟
        </footer>
      </body>
    </html>
  );
}
