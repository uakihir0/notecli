import { describe, expect, it } from "vitest";

import {
  CookieJar,
  SESSION_COOKIE,
  XSRF_COOKIE,
  assertSessionCookie,
  decodeXsrfToken,
  parseCookieInput,
} from "../src/lib/cookies.js";
import { InputError } from "../src/lib/errors.js";

describe("parseCookieInput", () => {
  it("parses a raw Cookie header", () => {
    const cookies = parseCookieInput(
      `Cookie: ${SESSION_COOKIE}=abc%2Fdef; ${XSRF_COOKIE}=token%3D1; Path=/; HttpOnly`
    );
    expect(cookies[SESSION_COOKIE]).toBe("abc%2Fdef");
    expect(cookies[XSRF_COOKIE]).toBe("token%3D1");
    expect(cookies.Path).toBeUndefined();
    expect(cookies.HttpOnly).toBeUndefined();
  });

  it("parses a JSON object", () => {
    const cookies = parseCookieInput(
      JSON.stringify({ [SESSION_COOKIE]: "session", [XSRF_COOKIE]: "xsrf" })
    );
    expect(cookies).toEqual({ [SESSION_COOKIE]: "session", [XSRF_COOKIE]: "xsrf" });
  });

  it("parses a Playwright-style JSON array", () => {
    const cookies = parseCookieInput(
      JSON.stringify([
        { name: SESSION_COOKIE, value: "session" },
        { name: XSRF_COOKIE, value: "xsrf" },
      ])
    );
    expect(cookies[SESSION_COOKIE]).toBe("session");
    expect(cookies[XSRF_COOKIE]).toBe("xsrf");
  });

  it("parses a Netscape cookies.txt file, including HttpOnly lines", () => {
    const input = [
      "# Netscape HTTP Cookie File",
      `.note.com\tTRUE\t/\tTRUE\t1893456000\t${SESSION_COOKIE}\tsession`,
      `.note.com\tTRUE\t/\tFALSE\t1893456000\t${XSRF_COOKIE}\txsrf`,
    ].join("\n");
    expect(parseCookieInput(input)).toEqual({
      [SESSION_COOKIE]: "session",
      [XSRF_COOKIE]: "xsrf",
    });
  });

  it("preserves '=' characters in cookie values", () => {
    const cookies = parseCookieInput(`${SESSION_COOKIE}=abc==`);
    expect(cookies[SESSION_COOKIE]).toBe("abc==");
  });

  it("rejects an input without cookies", () => {
    expect(() => parseCookieInput("Path=/\nDomain=note.com")).toThrow(InputError);
  });

  it("requires the note.com session cookie", () => {
    expect(() => assertSessionCookie({ [XSRF_COOKIE]: "xsrf" })).toThrow(
      /_note_session_v5/
    );
  });
});

describe("CookieJar", () => {
  it("tracks Set-Cookie updates and deletions", () => {
    const jar = new CookieJar({ existing: "1" });
    jar.updateFromSetCookie([
      `${XSRF_COOKIE}=new-token; Path=/; Secure`,
      "existing=; Max-Age=0; Path=/",
    ]);
    expect(jar.get(XSRF_COOKIE)).toBe("new-token");
    expect(jar.get("existing")).toBeUndefined();
    expect(jar.didChange()).toBe(true);
    expect(jar.toHeader()).toBe(`${XSRF_COOKIE}=new-token`);
  });

  it("decodes a URL-encoded XSRF token", () => {
    const jar = new CookieJar({ [XSRF_COOKIE]: "abc%3D%3D" });
    expect(jar.xsrfToken()).toBe("abc==");
    expect(decodeXsrfToken("abc%3D%3D")).toBe("abc==");
  });
});
