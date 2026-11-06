import { describe, expect, it, vi } from "vitest";

import { NoteApiClient, requireArticleKey } from "../src/lib/api.js";
import { CookieJar, SESSION_COOKIE, XSRF_COOKIE } from "../src/lib/cookies.js";
import { ApiError, AuthError, InputError, NotFoundError, RateLimitError } from "../src/lib/errors.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function jar(): CookieJar {
  return new CookieJar({
    [SESSION_COOKIE]: "session-value",
    [XSRF_COOKIE]: "token%3D1",
  });
}

describe("NoteApiClient", () => {
  it("sends cookies and the decoded XSRF token on mutations", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { result: true } })
    );
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.post("/v1/text_notes", { name: "test" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/api/v1/text_notes");
    const headers = init!.headers as Record<string, string>;
    expect(headers.Cookie).toContain(`${SESSION_COOKIE}=session-value`);
    expect(headers["X-XSRF-TOKEN"]).toBe("token=1");
    expect(headers.Origin).toBe("https://editor.note.com");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init!.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("does not send editor headers on GET", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: {} })
    );
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get("/v2/self");

    const init = fetchMock.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Origin).toBeUndefined();
    expect(headers["X-XSRF-TOKEN"]).toBeUndefined();
  });

  it("adds query parameters and skips undefined values", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: {} })
    );
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get("/v2/note_list/contents", {
      page: 2,
      publish_status: "draft",
      missing: undefined,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("publish_status")).toBe("draft");
    expect(url.searchParams.has("missing")).toBe(false);
  });

  it("captures rotated cookies from Set-Cookie", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(
          { data: {} },
          200,
          { "set-cookie": `${XSRF_COOKIE}=rotated%3D2; Path=/; Secure` }
        )
    );
    const cookieJar = new CookieJar({ [SESSION_COOKIE]: "session-value" });
    const client = new NoteApiClient(cookieJar, {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get("/v2/self");
    expect(cookieJar.get(XSRF_COOKIE)).toBe("rotated%3D2");
    expect(cookieJar.xsrfToken()).toBe("rotated=2");
  });

  it("fetches an XSRF token before the first mutation when only the session cookie exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { data: { id: 42, urlname: "writer" } },
          200,
          { "set-cookie": `${XSRF_COOKIE}=issued%3Dtoken; Path=/; Secure` }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: { result: true } }));

    const cookieJar = new CookieJar({ [SESSION_COOKIE]: "session-value" });
    const client = new NoteApiClient(cookieJar, {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.post("/v1/text_notes", { name: "test" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-XSRF-TOKEN"]).toBe("issued=token");
    expect(cookieJar.get(XSRF_COOKIE)).toBe("issued%3Dtoken");
  });

  it("maps 401 to an auth error", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch,
    });
    await expect(client.get("/v2/self")).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 404 to a not-found error", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "missing" }, 404)) as unknown as typeof fetch,
    });
    await expect(client.get("/v3/notes/n123")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps 429 to a rate-limit error with retry_after", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: "slow down" }, 429, { "retry-after": "7" })
      ) as unknown as typeof fetch,
    });

    const error = await client.get("/v2/note_list/contents").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(7);
  });

  it("maps other failures to API errors", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(client.get("/v2/self")).rejects.toBeInstanceOf(ApiError);
  });

  it("maps HTTP 200 error payloads to API errors", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: { code: "invalid", message: "画像の比率が不正です" } })
      ) as unknown as typeof fetch,
    });

    await expect(client.post("/v1/image_upload/note_eyecatch", {})).rejects.toThrow(
      /画像の比率が不正です/
    );
  });

  it("explains email activation errors on 422", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "email_activation",
              message: "メール認証が完了していないため投稿できません。",
            },
          },
          422
        )
      ) as unknown as typeof fetch,
    });

    await expect(client.post("/v1/text_notes", {})).rejects.toThrow(/email verification/);
  });

  it("explains email activation errors on 403", async () => {
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ data: { error: "email_activation" } }, 403)
      ) as unknown as typeof fetch,
    });

    await expect(client.post("/v2/notes/n123/access_tokens", {})).rejects.toThrow(
      /email verification/
    );
  });

  it("retrieves the current user from the stats endpoint", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      jsonResponse({ data: { user_id: 42, urlname: "writer" } })
    );
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: "42", urlname: "writer" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/stats/pv");
    expect(url.searchParams.get("filter")).toBe("all");
  });

  it("falls back to /v2/self when the stats endpoint fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 42, urlname: "writer" } }));
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: "42", urlname: "writer" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("validates the session with /v3/current_user/features as a last resort", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: "missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ data: { features: [] } }));
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getCurrentUser()).resolves.toEqual({ id: "", urlname: "" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const url = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(url.pathname).toBe("/api/v3/current_user/features");
  });

  it("treats a 200 not_login payload as an auth error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "auth", message: "not_login" } })
    );
    const client = new NoteApiClient(jar(), {
      baseUrl: "https://example.test/api",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(AuthError);
  });
});

describe("requireArticleKey", () => {
  it("accepts note article keys", () => {
    expect(requireArticleKey("n1234567890ab")).toBe("n1234567890ab");
  });

  it("rejects numeric IDs and arbitrary strings", () => {
    expect(() => requireArticleKey("123456")).toThrow(InputError);
    expect(() => requireArticleKey("hello")).toThrow(InputError);
  });
});
