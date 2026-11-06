import { loadAuthContext, type AuthContext, type UserInfo } from "./config.js";
import { CookieJar } from "./cookies.js";
import {
  ApiError,
  AuthError,
  InputError,
  NotFoundError,
  RateLimitError,
} from "./errors.js";

export const DEFAULT_API_BASE = "https://note.com/api";
export const NOTE_EDITOR_ORIGIN = "https://editor.note.com";
export const NOTE_EDITOR_REFERER = "https://editor.note.com/";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

export interface NoteApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

function responseSnippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 800 ? `${compact.slice(0, 800)}...` : compact;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

/**
 * Thin, authenticated client for note.com's unofficial API.
 *
 * The client only speaks JSON (plus multipart uploads) and follows rotated
 * cookies from Set-Cookie headers. It never logs Cookie or X-XSRF-TOKEN.
 */
export class NoteApiClient {
  readonly jar: CookieJar;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private xsrfFetchAttempted = false;

  constructor(jar: CookieJar, options: NoteApiClientOptions = {}) {
    this.jar = jar;
    this.baseUrl = (options.baseUrl ?? process.env.NOTE_API_BASE ?? DEFAULT_API_BASE).replace(
      /\/+$/,
      ""
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.NOTE_TIMEOUT_MS ?? 30_000);
    this.userAgent = options.userAgent ?? process.env.NOTE_USER_AGENT ?? DEFAULT_USER_AGENT;
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async post<T>(path: string, json?: unknown): Promise<T> {
    return this.request<T>("POST", path, { json });
  }

  async put<T>(path: string, json?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { json });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  async postForm<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>("POST", path, { form });
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const upperMethod = method.toUpperCase();
    if (
      upperMethod !== "GET" &&
      upperMethod !== "HEAD" &&
      !this.jar.xsrfToken() &&
      !this.xsrfFetchAttempted
    ) {
      // Some users only copy the HttpOnly session cookie. Make one harmless
      // GET so note.com can issue/rotate XSRF-TOKEN before a mutation.
      this.xsrfFetchAttempted = true;
      try {
        await this.request("GET", "/v2/self");
      } catch {
        // The mutation will surface a useful error if authentication is bad.
      }
    }

    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(method, options);
    const init: RequestInit = {
      method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (options.json !== undefined) {
      init.body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      init.body = options.form;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ApiError(
          `Request to note.com timed out after ${this.timeoutMs}ms.`,
          undefined,
          { method, path },
          error
        );
      }
      throw new ApiError(
        `Network error while calling note.com: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { method, path },
        error
      );
    }

    this.captureCookies(response.headers);
    const text = await response.text();

    if (!response.ok) {
      throw this.mapError(response, text);
    }

    if (!text.trim()) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        `note.com returned a non-JSON response (HTTP ${response.status}).`,
        response.status,
        { method, path, response: responseSnippet(text) }
      );
    }
  }

  async getCurrentUser(): Promise<UserInfo> {
    try {
      const response = await this.get<Record<string, unknown>>("/v2/self");
      const user = extractUser(response);
      if (user) {
        return user;
      }
    } catch (error) {
      if (error instanceof AuthError || error instanceof RateLimitError) {
        throw error;
      }
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }

    const response = await this.get<Record<string, unknown>>("/v1/stats/pv");
    const user = extractUser(response);
    if (user) {
      return user;
    }

    throw new AuthError(
      "note.com accepted the request but did not return user information. " +
        "The session cookie may be invalid or expired. Run \"notecli auth login\"."
    );
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(method: string, options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": this.userAgent,
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      ...options.headers,
    };

    if (this.jar.hasSession()) {
      headers.Cookie = this.jar.toHeader();
    }

    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
      const xsrf = this.jar.xsrfToken();
      if (xsrf) {
        headers["X-XSRF-TOKEN"] = xsrf;
      }
      headers.Origin = NOTE_EDITOR_ORIGIN;
      headers.Referer = NOTE_EDITOR_REFERER;
      headers["X-Requested-With"] = "XMLHttpRequest";
      headers["Sec-Fetch-Site"] = "same-site";
      headers["Sec-Fetch-Mode"] = "cors";
      headers["Sec-Fetch-Dest"] = "empty";
    }

    return headers;
  }

  private captureCookies(headers: Headers): void {
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    if (typeof getSetCookie === "function") {
      const setCookies = getSetCookie.call(headers);
      if (setCookies.length > 0) {
        this.jar.updateFromSetCookie(setCookies);
      }
      return;
    }

    const single = headers.get("set-cookie");
    if (single) {
      this.jar.updateFromSetCookie([single]);
    }
  }

  private mapError(response: Response, text: string): Error {
    const status = response.status;
    const responseInfo = responseSnippet(text);
    const details = responseInfo ? { response: responseInfo } : undefined;

    if (status === 401) {
      return new AuthError(
        "Authentication failed (HTTP 401). The note.com session cookie may be expired. " +
          "Run \"notecli auth login\" or update NOTE_COOKIE."
      );
    }
    if (status === 419) {
      return new AuthError(
        "The XSRF token was rejected (HTTP 419). Re-authenticate with a fresh Cookie header " +
          "that includes XSRF-TOKEN."
      );
    }
    if (status === 404) {
      return new NotFoundError("The requested note.com resource was not found.", details);
    }
    if (status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      return new RateLimitError(
        "note.com rate limit exceeded. Wait before making more requests.",
        retryAfter,
        details
      );
    }
    if (status === 403) {
      return new ApiError(
        "Access denied by note.com (HTTP 403). The session may lack permission, " +
          "or the XSRF token may be missing.",
        status,
        details
      );
    }
    if (status >= 500) {
      return new ApiError("note.com returned a server error. Try again later.", status, details);
    }

    return new ApiError(
      `note.com API request failed (HTTP ${status}).`,
      status,
      details
    );
  }
}

function extractUser(response: Record<string, unknown>): UserInfo | null {
  const data = response.data;
  if (data === null || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const nested = record.user;
  const source =
    nested !== null && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : record;

  const rawId = source.id ?? source.user_id;
  const rawUrlname = source.urlname ?? source.username ?? source.name;
  if (rawId === undefined || rawId === null || String(rawId) === "") {
    return null;
  }

  return {
    id: String(rawId),
    urlname: rawUrlname === undefined || rawUrlname === null ? "" : String(rawUrlname),
  };
}

/**
 * Load credentials, construct a client, run the callback, and persist any
 * rotated cookies back to the credentials file.
 */
export async function withClient<T>(
  callback: (client: NoteApiClient, auth: AuthContext) => Promise<T>
): Promise<T> {
  const auth = await loadAuthContext();
  const client = new NoteApiClient(auth.jar);
  let commandError: unknown;

  try {
    return await callback(client, auth);
  } catch (error) {
    commandError = error;
    throw error;
  } finally {
    try {
      await auth.persist();
    } catch (error) {
      if (commandError === undefined) {
        throw error;
      }
    }
  }
}

export function requireArticleKey(value: string): string {
  const normalized = value.trim();
  if (!/^n[a-zA-Z0-9]+$/.test(normalized)) {
    throw new InputError(
      `Invalid article key "${value}". Use the key shown by "notecli list" (for example, n1234567890ab).`
    );
  }
  return normalized;
}
