import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCredentials,
  getCredentialsPath,
  loadAuthContext,
  loadCredentials,
  saveCredentials,
} from "../src/lib/config.js";
import { SESSION_COOKIE, XSRF_COOKIE } from "../src/lib/cookies.js";
import { AuthError } from "../src/lib/errors.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "notecli-config-"));
  delete process.env.NOTE_COOKIE;
  delete process.env.NOTE_COOKIE_FILE;
  vi.stubEnv("NOTE_CONFIG_DIR", tempDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("credential storage", () => {
  it("writes the credentials file with owner-only permissions", async () => {
    await saveCredentials(
      { [SESSION_COOKIE]: "session", [XSRF_COOKIE]: "xsrf" },
      { id: "42", urlname: "tester" }
    );

    const path = getCredentialsPath();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);

    const stored = await loadCredentials(path);
    expect(stored?.cookies[SESSION_COOKIE]).toBe("session");
    expect(stored?.user?.urlname).toBe("tester");
  });

  it("loads credentials from the config file", async () => {
    await saveCredentials({ [SESSION_COOKIE]: "session" });
    const auth = await loadAuthContext();
    expect(auth.source).toBe("file");
    expect(auth.jar.get(SESSION_COOKIE)).toBe("session");
  });

  it("ignores empty environment variables and falls back to the file", async () => {
    await saveCredentials({ [SESSION_COOKIE]: "session" });
    vi.stubEnv("NOTE_COOKIE", "");
    vi.stubEnv("NOTE_COOKIE_FILE", "");

    const auth = await loadAuthContext();
    expect(auth.source).toBe("file");
  });

  it("prefers NOTE_COOKIE over the credentials file", async () => {
    await saveCredentials({ [SESSION_COOKIE]: "from-file" });
    vi.stubEnv("NOTE_COOKIE", `${SESSION_COOKIE}=from-env`);

    const auth = await loadAuthContext();
    expect(auth.source).toBe("env:NOTE_COOKIE");
    expect(auth.jar.get(SESSION_COOKIE)).toBe("from-env");
  });

  it("supports NOTE_COOKIE_FILE", async () => {
    const cookieFile = join(tempDir, "cookies.txt");
    await writeFile(cookieFile, `${SESSION_COOKIE}=from-file-env\n`);
    vi.stubEnv("NOTE_COOKIE_FILE", cookieFile);

    const auth = await loadAuthContext();
    expect(auth.source).toBe("env:NOTE_COOKIE_FILE");
    expect(auth.jar.get(SESSION_COOKIE)).toBe("from-file-env");
  });

  it("does not persist cookies loaded from environment variables", async () => {
    vi.stubEnv("NOTE_COOKIE", `${SESSION_COOKIE}=session`);
    const auth = await loadAuthContext();
    auth.jar.set("rotated", "1");
    await auth.persist();
    await expect(readFile(getCredentialsPath(), "utf8")).rejects.toThrow();
  });

  it("persists rotated cookies for file-backed credentials", async () => {
    await saveCredentials({ [SESSION_COOKIE]: "session" });
    const auth = await loadAuthContext();
    auth.jar.set(XSRF_COOKIE, "rotated");
    await auth.persist();

    const stored = await loadCredentials();
    expect(stored?.cookies[XSRF_COOKIE]).toBe("rotated");
  });

  it("returns an auth error when no credentials exist", async () => {
    await expect(loadAuthContext()).rejects.toThrow(AuthError);
  });

  it("removes the credentials file", async () => {
    await saveCredentials({ [SESSION_COOKIE]: "session" });
    await expect(clearCredentials()).resolves.toBe(true);
    await expect(clearCredentials()).resolves.toBe(false);
  });
});
