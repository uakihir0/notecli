import { InputError } from "./errors.js";

export type CookieMap = Record<string, string>;

const COOKIE_ATTRIBUTES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "httponly",
  "secure",
  "samesite",
  "priority",
  "partitioned",
]);

/** The session cookie required by note.com's API. */
export const SESSION_COOKIE = "_note_session_v5";
export const XSRF_COOKIE = "XSRF-TOKEN";

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseRawCookieHeader(input: string): CookieMap {
  const cookies: CookieMap = {};
  const withoutPrefix = input.replace(/^\s*cookie\s*:\s*/i, "");

  for (const part of withoutPrefix.split(/[;\n\r]+/)) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }

    const equalsIndex = segment.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const name = segment.slice(0, equalsIndex).trim();
    const value = stripQuotes(segment.slice(equalsIndex + 1));
    if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) {
      continue;
    }
    cookies[name] = value;
  }

  return cookies;
}

function parseNetscapeCookieFile(input: string): CookieMap | null {
  const cookies: CookieMap = {};
  let found = false;

  for (const rawLine of input.split(/\r?\n/)) {
    let line = rawLine;
    if (line.startsWith("#HttpOnly_")) {
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#") || line.trim() === "") {
      continue;
    }

    const fields = line.split("\t");
    if (fields.length < 7) {
      return null;
    }

    if (!isNoteDomain(fields[0])) {
      continue;
    }

    const name = fields[5]?.trim() ?? "";
    const value = fields[6] ?? "";
    if (name) {
      cookies[name] = value;
      found = true;
    }
  }

  return found ? cookies : null;
}

function isNoteDomain(domain: string | undefined): boolean {
  if (!domain) {
    return true;
  }
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return normalized === "note.com" || normalized.endsWith(".note.com");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonCookies(input: string): CookieMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  const candidate =
    !Array.isArray(parsed) && isRecord(parsed) && parsed.cookies !== undefined
      ? parsed.cookies
      : parsed;

  const cookies: CookieMap = {};

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = record.name ?? record.Name;
      const value = record.value ?? record.Value;
      const domain = record.domain ?? record.Domain;
      if (
        typeof name === "string" &&
        typeof value === "string" &&
        (typeof domain !== "string" || isNoteDomain(domain))
      ) {
        cookies[name] = value;
      }
    }
    return cookies;
  }

  if (!isRecord(candidate)) {
    return null;
  }

  for (const [name, value] of Object.entries(candidate)) {
    if (typeof value === "string") {
      cookies[name] = value;
    }
  }

  return cookies;
}

/**
 * Parse cookie material in any of these formats:
 *   - a raw `Cookie:` header (`a=b; c=d`)
 *   - a JSON object (`{"a":"b"}`)
 *   - a JSON array of `{name, value}` objects (Playwright export)
 *   - a Netscape cookies.txt file (browser extension export)
 */
export function parseCookieInput(input: string): CookieMap {
  const trimmed = input.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new InputError(
      "Cookie input is empty. Pass a Cookie header, a JSON cookie object, or a Netscape cookies.txt file."
    );
  }

  const jsonCookies = trimmed.startsWith("{") || trimmed.startsWith("[")
    ? parseJsonCookies(trimmed)
    : null;

  let cookies = jsonCookies;
  if (cookies === null) {
    cookies = parseNetscapeCookieFile(trimmed);
  }
  if (cookies === null) {
    cookies = parseRawCookieHeader(trimmed);
  }

  if (Object.keys(cookies).length === 0) {
    throw new InputError(
      "Could not parse any cookies from the input. Expected a Cookie header, JSON, or Netscape cookies.txt."
    );
  }

  return cookies;
}

export function assertSessionCookie(cookies: CookieMap): void {
  if (!cookies[SESSION_COOKIE]) {
    throw new InputError(
      `The required note.com session cookie "${SESSION_COOKIE}" is missing. ` +
        "Copy the full Cookie header from your browser, including HttpOnly cookies. " +
        "See README.md for instructions.",
      { cookieNames: Object.keys(cookies) }
    );
  }
}

/** Decode the XSRF token the way Axios/browser clients do. */
export function decodeXsrfToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function cookieHeader(cookies: CookieMap): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** A small cookie jar that follows Set-Cookie headers from API responses. */
export class CookieJar {
  private cookies: CookieMap;
  private changed = false;

  constructor(cookies: CookieMap = {}) {
    this.cookies = { ...cookies };
  }

  get(name: string): string | undefined {
    return this.cookies[name];
  }

  set(name: string, value: string): void {
    this.cookies[name] = value;
    this.changed = true;
  }

  delete(name: string): void {
    if (name in this.cookies) {
      delete this.cookies[name];
      this.changed = true;
    }
  }

  toJSON(): CookieMap {
    return { ...this.cookies };
  }

  toHeader(): string {
    return cookieHeader(this.cookies);
  }

  xsrfToken(): string | undefined {
    return decodeXsrfToken(this.cookies[XSRF_COOKIE]);
  }

  hasSession(): boolean {
    return Boolean(this.cookies[SESSION_COOKIE]);
  }

  didChange(): boolean {
    return this.changed;
  }

  updateFromSetCookie(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      this.updateFromSetCookieHeader(header);
    }
  }

  private updateFromSetCookieHeader(header: string): void {
    const firstSegment = header.split(";", 1)[0]?.trim() ?? "";
    const equalsIndex = firstSegment.indexOf("=");
    if (equalsIndex <= 0) {
      return;
    }

    const name = firstSegment.slice(0, equalsIndex).trim();
    const value = stripQuotes(firstSegment.slice(equalsIndex + 1));
    const lowerHeader = header.toLowerCase();
    const expired =
      value === "" ||
      /;\s*max-age=0(?:;|$)/i.test(lowerHeader) ||
      /;\s*expires=thu,\s*01\s+jan\s+1970/i.test(lowerHeader);

    if (expired) {
      this.delete(name);
    } else {
      this.set(name, value);
    }
  }
}
