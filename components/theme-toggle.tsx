"use client";

import { useCallback, useEffect, useState } from "react";

/** 主题切换：dark class + localStorage 持久化，与 layout 里的防闪烁脚本约定一致 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("sp-theme", next ? "dark" : "light");
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
    setDark(next);
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "切换到浅色模式" : "切换到深色模式"}
      aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {mounted && dark ? "🌙" : "☀️"}
    </button>
  );
}
