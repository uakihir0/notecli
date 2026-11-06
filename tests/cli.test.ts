import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../src/cli.js";
import { SESSION_COOKIE, XSRF_COOKIE } from "../src/lib/cookies.js";

let stdout = "";
let stderr = "";
let configDir = "";

function writeSpy(target: NodeJS.WriteStream): void {
  vi.spyOn(target, "write").mockImplementation(((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (target === process.stdout) {
      stdout += text;
    } else {
      stderr += text;
    }
    return true;
  }) as typeof target.write);
}

async function runCli(...args: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(["node", "notecli", ...args]);
}

beforeEach(async () => {
  stdout = "";
  stderr = "";
  process.exitCode = 0;
  configDir = await mkdtemp(join(tmpdir(), "notecli-cli-"));
  writeSpy(process.stdout);
  writeSpy(process.stderr);
  vi.stubEnv("NOTE_CONFIG_DIR", configDir);
  vi.stubEnv("NOTE_COOKIE", `${SESSION_COOKIE}=super-secret-session; ${XSRF_COOKIE}=super-secret-xsrf`);
  delete process.env.NOTE_COOKIE_FILE;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockFetch(router: (url: URL, init: RequestInit) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return router(url, init ?? {});
    })
  );
}

describe("CLI", () => {
  it("lists articles as JSON when stdout is not a TTY", async () => {
    mockFetch((url) => {
      expect(url.pathname).toBe("/api/v2/note_list/contents");
      expect(url.searchParams.get("page")).toBe("1");
      return new Response(
        JSON.stringify({
          data: {
            notes: [{ id: 1, key: "n1", name: "Hello", status: "draft" }],
            totalCount: 1,
            isLastPage: true,
          },
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    await runCli("list", "--json");

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(stdout) as {
      articles: Array<{ key: string; title: string }>;
      total: number;
      has_more: boolean;
    };
    expect(output.articles[0]?.key).toBe("n1");
    expect(output.total).toBe(1);
    expect(output.has_more).toBe(false);
  });

  it("gets an article and returns Markdown plus raw HTML", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: {
              id: 1,
              key: "n1",
              name: "Hello",
              status: "draft",
              note_draft: { body: '<p name="x" id="x">Body</p>' },
            },
          }),
          { headers: { "content-type": "application/json" } }
        )
    );

    await runCli("get", "n1", "--json");

    const output = JSON.parse(stdout) as { body: string; body_html: string; key: string };
    expect(output.key).toBe("n1");
    expect(output.body).toContain("Body");
    expect(output.body_html).toContain("<p");
  });

  it("creates a draft from a --body argument", async () => {
    const paths: string[] = [];
    mockFetch((url) => {
      paths.push(url.pathname);
      if (url.pathname === "/api/v1/text_notes") {
        return new Response(JSON.stringify({ data: { id: 1, key: "n1" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { result: true } }), {
        headers: { "content-type": "application/json" },
      });
    });

    await runCli("create", "--title", "Hello", "--body", "# Hello", "--json");

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(stdout) as {
      article: { key: string; status: string };
      published: boolean;
    };
    expect(output.article.key).toBe("n1");
    expect(output.article.status).toBe("draft");
    expect(output.published).toBe(false);
    expect(paths).toEqual(["/api/v1/text_notes", "/api/v1/text_notes/draft_save"]);
  });

  it("reports missing authentication as structured JSON with exit code 3", async () => {
    vi.stubEnv("NOTE_COOKIE", "");
    delete process.env.NOTE_COOKIE;

    await runCli("list", "--json");

    expect(process.exitCode).toBe(3);
    const error = JSON.parse(stderr) as { error: { code: string } };
    expect(error.error.code).toBe("auth_error");
  });

  it("requires --yes to delete when stdin is not a TTY", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ data: {} }), {
          headers: { "content-type": "application/json" },
        })
    );

    await runCli("delete", "n1", "--json");

    expect(process.exitCode).toBe(7);
    const error = JSON.parse(stderr) as { error: { code: string } };
    expect(error.error.code).toBe("input_error");
    expect(stdout).toBe("");
  });

  it("checks auth status without exposing cookie values", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ data: { id: 42, urlname: "writer" } }), {
          headers: { "content-type": "application/json" },
        })
    );

    await runCli("auth", "status", "--json");

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(stdout) as {
      authenticated: boolean;
      user: { id: string; urlname: string };
      cookie_names: string[];
    };
    expect(output.authenticated).toBe(true);
    expect(output.user.urlname).toBe("writer");
    expect(output.cookie_names).toContain(SESSION_COOKIE);
    expect(stdout).not.toContain("super-secret-session");
    expect(stdout).not.toContain("super-secret-xsrf");
  });

  it("stores NOTE_COOKIE via auth login and reads it back from disk", async () => {
    await runCli("auth", "login", "--no-verify", "--json");

    expect(process.exitCode).toBe(0);
    expect(stdout).not.toContain("super-secret-session");
    const stored = JSON.parse(
      await readFile(join(configDir, "credentials.json"), "utf8")
    ) as { cookies: Record<string, string>; version: number };
    expect(stored.version).toBe(1);
    expect(stored.cookies[SESSION_COOKIE]).toBe("super-secret-session");

    delete process.env.NOTE_COOKIE;
    stdout = "";
    mockFetch(
      () =>
        new Response(JSON.stringify({ data: { id: 42, urlname: "writer" } }), {
          headers: { "content-type": "application/json" },
        })
    );

    await runCli("auth", "status", "--json");
    expect(process.exitCode).toBe(0);
    const output = JSON.parse(stdout) as { authenticated: boolean; source: string };
    expect(output.authenticated).toBe(true);
    expect(output.source).toBe("file");
  });

  it("prints human-readable tables in text mode", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: {
              notes: [{ id: 1, key: "n1", name: "Hello", status: "draft" }],
              totalCount: 1,
              isLastPage: true,
            },
          }),
          { headers: { "content-type": "application/json" } }
        )
    );

    await runCli("list", "--format", "text");

    expect(stdout).toContain("KEY");
    expect(stdout).toContain("n1");
    expect(stdout).toContain("Hello");
  });
});
