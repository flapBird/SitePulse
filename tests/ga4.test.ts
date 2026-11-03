import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAccessToken,
  mapApiError,
  normalizePropertyId,
  parseServiceAccount,
  pemToPkcs8,
} from "../lib/ga4";

function b64UrlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

async function makeTestCredentials(email: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  let bin = "";
  for (const byte of new Uint8Array(pkcs8)) bin += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  return { cred: { client_email: email, private_key: pem }, publicKey: pair.publicKey };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseServiceAccount", () => {
  it("解析合法 JSON", () => {
    const cred = parseServiceAccount(
      JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "xxx" }),
    );
    expect(cred.client_email).toBe("a@b.iam.gserviceaccount.com");
  });

  it("拒绝非法 JSON 与缺失字段", () => {
    expect(() => parseServiceAccount("{not json")).toThrow(/JSON/);
    expect(() => parseServiceAccount(JSON.stringify({}))).toThrow(/client_email/);
  });
});

describe("normalizePropertyId", () => {
  it("接受纯数字与 properties/ 前缀", () => {
    expect(normalizePropertyId("123456789")).toBe("123456789");
    expect(normalizePropertyId(" properties/123456789 ")).toBe("123456789");
  });

  it("拒绝非数字", () => {
    expect(() => normalizePropertyId("abc")).toThrow(/纯数字/);
  });
});

describe("mapApiError", () => {
  it("按状态码归一化", () => {
    expect(mapApiError(403, "permission denied").code).toBe("PERMISSION");
    expect(mapApiError(401, "invalid token").code).toBe("AUTH");
    expect(mapApiError(404, "Property not found").code).toBe("NOT_FOUND");
    expect(mapApiError(429, "quota").code).toBe("QUOTA");
    expect(mapApiError(503, "backend").code).toBe("REQUEST");
    expect(mapApiError(403, "permission denied").message).toContain("查看者");
  });
});

describe("pemToPkcs8", () => {
  it("剥离 PEM 头尾并解码", () => {
    const bytes = pemToPkcs8("-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});

describe("getAccessToken", () => {
  it("签发 RS256 JWT 并换取 token", async () => {
    const { cred, publicKey } = await makeTestCredentials(`t${Date.now()}@test.iam.gserviceaccount.com`);

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const params = new URLSearchParams(body);
      const assertion = params.get("assertion") ?? "";
      const [headerPart, payloadPart, sigPart] = assertion.split(".");
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

      const header = JSON.parse(b64UrlDecode(headerPart));
      const payload = JSON.parse(b64UrlDecode(payloadPart));
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload.scope).toBe("https://www.googleapis.com/auth/analytics.readonly");
      expect(payload.iss).toBe(cred.client_email);
      expect(payload.aud).toBe("https://oauth2.googleapis.com/token");

      // 用公钥验证签名
      const spki = await crypto.subtle.exportKey("spki", publicKey);
      const imported = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
      const sigBytes = Uint8Array.from(atob(sigPart.replaceAll("-", "+").replaceAll("_", "/") + "=="), (c) =>
        c.charCodeAt(0),
      );
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        imported,
        sigBytes,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      );
      expect(ok).toBe(true);

      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await getAccessToken(cred);
    expect(token).toBe("test-token");

    // 第二次调用命中缓存，不再请求 OAuth
    await getAccessToken(cred);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("OAuth 失败时抛出 AUTH 错误", async () => {
    const { cred } = await makeTestCredentials(`t${Date.now() + 1}@test.iam.gserviceaccount.com`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid_grant" } }), { status: 400 })),
    );
    await expect(getAccessToken(cred)).rejects.toMatchObject({ code: "AUTH" });
  });
});
