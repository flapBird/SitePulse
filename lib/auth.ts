/**
 * 登录会话：DASHBOARD_PASSWORD 未设置时整个 Dashboard 开放；
 * 设置后通过 HttpOnly Cookie 会话保护所有页面与 API。
 *
 * 会话令牌 = base64url(payload).base64url(HMAC-SHA256(payload, key))，
 * key = SHA-256(DASHBOARD_PASSWORD)——修改密码会使所有已发会话立即失效。
 * 纯 WebCrypto，可在 Workers 与 Node 环境运行。
 */

export const SESSION_COOKIE = "sp_session";
/** 会话有效期：7 天 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const textEncoder = new TextEncoder();

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(password: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(password));
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(payload: string, key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return bytesToB64Url(new Uint8Array(sig));
}

export interface SessionPayload {
  /** 过期时间（epoch 毫秒） */
  exp: number;
  /** 签发时间（epoch 毫秒） */
  iat: number;
}

/** 为给定密码签发会话令牌 */
export async function createSessionToken(password: string, now: number = Date.now()): Promise<string> {
  const payload: SessionPayload = { exp: now + SESSION_TTL_SECONDS * 1000, iat: now };
  const encoded = bytesToB64Url(textEncoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(password);
  const sig = await sign(encoded, key);
  return `${encoded}.${sig}`;
}

/** 校验会话令牌：签名正确且未过期 */
export async function verifySessionToken(
  token: string,
  password: string,
  now: number = Date.now(),
): Promise<boolean> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await hmacKey(password);
    const expected = await sign(encoded, key);
    if (!timingSafeEqual(sig, expected)) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(encoded))) as Partial<SessionPayload>;
    return typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}

/** 从 Cookie 头中取会话令牌 */
export function sessionFromCookieHeader(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === SESSION_COOKIE) return part.slice(idx + 1).trim() || undefined;
  }
  return undefined;
}

/** 恒定时间字符串比较（防时序侧信道） */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
