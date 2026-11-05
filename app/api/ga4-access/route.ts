import { getAccessToken } from "@/lib/ga4";
import { getCredential } from "@/lib/env";
import { requireSession } from "@/lib/guards";

export const dynamic = "force-dynamic";

interface AdminAccountSummary {
  account?: { displayName?: string; name?: string };
  propertySummaries?: { property?: string; displayName?: string; parent?: string }[];
}

/**
 * 临时诊断端点：通过 GA4 Admin API 列出当前服务账号有权访问的
 * 全部账号与 Property，用于排查 403（授权加错位置 / 未生效）。
 * 纯文本输出，浏览器直接可读。定位完成后删除。
 */
export async function GET(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;

  const cred = getCredential();
  if (!cred.ok) {
    return new Response(`凭据未配置：${cred.message}`, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  let res: Response;
  try {
    const token = await getAccessToken(cred.cred);
    res = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return new Response(`调用 Google Admin API 失败：${err instanceof Error ? err.message : String(err)}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!res.ok) {
    return new Response(`Admin API 返回 ${res.status}：${(await res.text()).slice(0, 500)}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const data = (await res.json()) as { accountSummaries?: AdminAccountSummary[] };
  const summaries = data.accountSummaries ?? [];

  const lines: string[] = [
    `服务账号：${cred.cred.client_email}`,
    `可见 GA4 账号数：${summaries.length}`,
    "",
  ];

  if (summaries.length === 0) {
    lines.push("❗ 该服务账号当前看不到任何 GA4 账号 —— 授权未生效或加错了 GA 账号。");
    lines.push("请在 GA4 → 管理 → 账号访问管理 中确认已把它添加为「查看者」。");
  } else {
    for (const summary of summaries) {
      lines.push(`📁 账号：${summary.account?.displayName ?? "(未命名)"}（${summary.account?.name ?? "?"}）`);
      const props = summary.propertySummaries ?? [];
      if (props.length === 0) {
        lines.push("   （该账号下没有可见 Property）");
      }
      for (const prop of props) {
        const id = (prop.property ?? "").replace("properties/", "");
        lines.push(`   🔹 Property ${id} — ${prop.displayName ?? "(未命名)"}`);
      }
      lines.push("");
    }
    lines.push("→ 把看板站点的 Property ID 换成上面列表中的某个 ID，或把服务账号加到列表之外的 Property 所在账号。");
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
