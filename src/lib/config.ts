import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AuthError, InputError } from "./errors.js";
import {
  assertSessionCookie,
  CookieJar,
  parseCookieInput,
  type CookieMap,
} from "./cookies.js";

export interface UserInfo {
  id: string;
  urlname: string;
}

export interface StoredCredentials {
  version: 1;
  cookies: CookieMap;
  created_at: string;
  updated_at: string;
  user?: UserInfo;
}

export type AuthSource = "env:NOTE_COOKIE" | "env:NOTE_COOKIE_FILE" | "file";

export interface AuthContext {
  jar: CookieJar;
  source: AuthSource;
  credentialsPath: string;
  user?: UserInfo;
  warnings: string[];
  persist(): Promise<void>;
}

export function getConfigDir(): string {
  const override = process.env.NOTE_CONFIG_DIR;
  if (override) {
    return resolve(override);
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(resolve(xdg), "notecli");
  }

  return join(homedir(), ".config", "notecli");
}

export function getCredentialsPath(): string {
  return join(getConfigDir(), "credentials.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCredentials(value: unknown, path: string): StoredCredentials {
  if (!isRecord(value) || !isRecord(value.cookies)) {
    throw new InputError(
      `The credentials file at ${path} is invalid. Run "notecli auth logout" and authenticate again.`
    );
  }

  const cookies: CookieMap = {};
  for (const [name, cookieValue] of Object.entries(value.cookies)) {
    if (typeof cookieValue === "string") {
      cookies[name] = cookieValue;
    }
  }

  assertSessionCookie(cookies);

  const user = isRecord(value.user)
    ? {
        id: String(value.user.id ?? ""),
        urlname: String(value.user.urlname ?? ""),
      }
    : undefined;

  return {
    version: 1,
    cookies,
    created_at: typeof value.created_at === "string" ? value.created_at : new Date().toISOString(),
    updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date().toISOString(),
    ...(user ? { user } : {}),
  };
}

export async function loadCredentials(
  path = getCredentialsPath()
): Promise<StoredCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw new InputError(
      `Could not read the credentials file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InputError(
      `The credentials file at ${path} is not valid JSON. Run "notecli auth logout" and authenticate again.`
    );
  }

  return validateCredentials(parsed, path);
}

async function fileModeWarnings(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      return [
        `The credentials file at ${path} is readable by other users. Run "chmod 600 ${path}".`,
      ];
    }
  } catch {
    // The file may not exist yet.
  }
  return [];
}

export async function saveCredentials(
  cookies: CookieMap,
  user?: UserInfo,
  path = getCredentialsPath()
): Promise<void> {
  assertSessionCookie(cookies);

  const existing = await loadCredentials(path).catch(() => null);
  const now = new Date().toISOString();
  const payload: StoredCredentials = {
    version: 1,
    cookies,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    ...(user ?? existing?.user ? { user: user ?? existing?.user } : {}),
  };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function clearCredentials(path = getCredentialsPath()): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw new InputError(
      `Could not remove the credentials file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function readCookieFile(path: string): Promise<string> {
  if (path === "-") {
    throw new InputError(
      'NOTE_COOKIE_FILE cannot be "-". Redirect a file path or use NOTE_COOKIE with stdin instead.'
    );
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new InputError(
      `Could not read the cookie file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load credentials with this precedence:
 *   1. NOTE_COOKIE (raw/JSON/Netscape content)
 *   2. NOTE_COOKIE_FILE (path to raw/JSON/Netscape content)
 *   3. ~/.config/notecli/credentials.json
 */
export async function loadAuthContext(): Promise<AuthContext> {
  const credentialsPath = getCredentialsPath();
  const envCookie = process.env.NOTE_COOKIE;
  const envCookieFile = process.env.NOTE_COOKIE_FILE;

  if (envCookie !== undefined) {
    if (!envCookie.trim()) {
      throw new AuthError("NOTE_COOKIE is set but empty.");
    }
    const cookies = parseCookieInput(envCookie);
    assertSessionCookie(cookies);
    return {
      jar: new CookieJar(cookies),
      source: "env:NOTE_COOKIE",
      credentialsPath,
      warnings: [],
      persist: async () => undefined,
    };
  }

  if (envCookieFile !== undefined) {
    if (!envCookieFile.trim()) {
      throw new AuthError("NOTE_COOKIE_FILE is set but empty.");
    }
    const cookies = parseCookieInput(await readCookieFile(envCookieFile));
    assertSessionCookie(cookies);
    return {
      jar: new CookieJar(cookies),
      source: "env:NOTE_COOKIE_FILE",
      credentialsPath,
      warnings: [],
      persist: async () => undefined,
    };
  }

  const stored = await loadCredentials(credentialsPath);
  if (!stored) {
    throw new AuthError(
      "No note.com credentials found. Set NOTE_COOKIE, set NOTE_COOKIE_FILE, or run \"notecli auth login\"."
    );
  }

  const jar = new CookieJar(stored.cookies);
  return {
    jar,
    source: "file",
    credentialsPath,
    ...(stored.user ? { user: stored.user } : {}),
    warnings: await fileModeWarnings(credentialsPath),
    async persist() {
      if (!jar.didChange()) {
        return;
      }
      await saveCredentials(jar.toJSON(), stored.user, credentialsPath);
    },
  };
}
