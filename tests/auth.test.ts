import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  sessionFromCookieHeader,
  timingSafeEqual,
  verifySessionToken,
} from "../lib/auth";

const PASSWORD = "test-password";

describe("createSessionToken / verifySessionToken", () => {
  it("签发并校验通过", async () => {
    const token = await createSessionToken(PASSWORD, 1_000_000);
    expect(await verifySessionToken(token, PASSWORD, 1_000_000)).toBe(true);
  });

  it("过期后校验失败", async () => {
    const token = await createSessionToken(PASSWORD, 1_000_000);
    const dayLater = 1_000_000 + 8 * 24 * 60 * 60 * 1000;
    expect(await verifySessionToken(token, PASSWORD, dayLater)).toBe(false);
  });

  it("密码不同校验失败", async () => {
    const token = await createSessionToken(PASSWORD, 1_000_000);
    expect(await verifySessionToken(token, "other-password", 1_000_000)).toBe(false);
  });

  it("篡改 payload 校验失败", async () => {
    const token = await createSessionToken(PASSWORD, 1_000_000);
    const [payload, sig] = token.split(".");
    // 把过期时间改到很远
    const decoded = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    decoded.exp = Date.now() + 3_600_000;
    const forged = btoa(JSON.stringify(decoded)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(await verifySessionToken(`${forged}.${sig}`, PASSWORD)).toBe(false);
  });

  it("垃圾输入返回 false", async () => {
    expect(await verifySessionToken("", PASSWORD)).toBe(false);
    expect(await verifySessionToken("not-a-token", PASSWORD)).toBe(false);
  });
});

describe("sessionFromCookieHeader", () => {
  it("从 Cookie 头解析会话", () => {
    const header = "other=1; sp_session=abc.def; another=2";
    expect(sessionFromCookieHeader(header)).toBe("abc.def");
  });

  it("缺失时返回 undefined", () => {
    expect(sessionFromCookieHeader(null)).toBeUndefined();
    expect(sessionFromCookieHeader("a=1")).toBeUndefined();
  });
});

describe("timingSafeEqual", () => {
  it("相同为 true，不同为 false", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
