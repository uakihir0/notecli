import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../src/cli.js";
import { SESSION_COOKIE, XSRF_COOKIE } from "../src/lib/cookies.js";

let stdout = "";
let stderr = "";
let server: ReturnType<typeof createServer> | null = null;
let baseUrl = "";

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
  await buildProgram().parseAsync(["node", "notecli", ...args]);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

let published = false;

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const body = await readBody(request);

  if (url.pathname === "/api/v2/self" && request.method === "GET") {
    json(response, 200, { data: { id: 42, urlname: "writer" } });
    return;
  }

  if (url.pathname === "/api/v2/note_list/contents" && request.method === "GET") {
    json(response, 200, {
      data: {
        notes: [{ id: 1, key: "n1", name: "Hello", status: published ? "published" : "draft" }],
        totalCount: 1,
        isLastPage: true,
      },
    });
    return;
  }

  if (url.pathname === "/api/v3/notes/n1" && request.method === "GET") {
    json(response, 200, {
      data: {
        id: 1,
        key: "n1",
        name: "Hello",
        body: "",
        status: published ? "published" : "draft",
        note_draft: { body: '<h1 name="h" id="h">Hello</h1>' },
        hashtags: [{ hashtag: { name: "note" } }],
        ...(published ? { noteUrl: "https://note.com/writer/n/n1" } : {}),
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/text_notes" && request.method === "POST") {
    expect(body).toContain('"name":"Hello"');
    json(response, 200, { data: { id: 1, key: "n1" } });
    return;
  }

  if (url.pathname === "/api/v1/text_notes/draft_save" && request.method === "POST") {
    expect(url.searchParams.get("id")).toBe("1");
    const payload = JSON.parse(body) as { body: string; body_length: number };
    expect(payload.body).toContain("<h1 ");
    expect(payload.body_length).toBeGreaterThan(0);
    json(response, 200, { data: { result: true } });
    return;
  }

  if (url.pathname === "/api/v1/text_notes/1" && request.method === "PUT") {
    const payload = JSON.parse(body) as {
      free_body: string;
      status: string;
      hashtags?: string[];
    };
    expect(payload.free_body).toContain("<h1 ");
    expect(payload.status).toBe("published");
    expect(payload.hashtags).toEqual(["#note"]);
    published = true;
    json(response, 200, { data: { result: true } });
    return;
  }

  if (url.pathname === "/api/v2/notes/n1/access_tokens" && request.method === "POST") {
    json(response, 200, { data: { preview_access_token: "preview-token" } });
    return;
  }

  if (url.pathname === "/api/v1/image_upload/note_eyecatch" && request.method === "POST") {
    expect(request.headers["content-type"]).toContain("multipart/form-data");
    expect(body).toContain('name="note_id"');
    expect(body).toContain('filename="pixel.png"');
    json(response, 200, {
      data: { url: "https://example.com/pixel.png", key: "image-key" },
    });
    return;
  }

  if (url.pathname === "/api/v1/notes/n/n1" && request.method === "DELETE") {
    json(response, 200, { data: { result: true } });
    return;
  }

  json(response, 404, { error: "not found" });
}

beforeEach(async () => {
  stdout = "";
  stderr = "";
  process.exitCode = 0;
  published = false;
  writeSpy(process.stdout);
  writeSpy(process.stderr);

  const configDir = await mkdtemp(join(tmpdir(), "notecli-e2e-"));
  vi.stubEnv("NOTE_CONFIG_DIR", configDir);
  vi.stubEnv("NOTE_COOKIE", `${SESSION_COOKIE}=secret-session; ${XSRF_COOKIE}=secret-xsrf`);

  server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}/api`;
  vi.stubEnv("NOTE_API_BASE", baseUrl);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server = null;
  });
});

describe("CLI against a local HTTP server", () => {
  it("creates, publishes, previews, and deletes an article", async () => {
    await runCli("create", "--title", "Hello", "--body", "# Hello", "--json");
    expect(process.exitCode).toBe(0);
    const created = JSON.parse(stdout) as { article: { key: string }; published: boolean };
    expect(created.article.key).toBe("n1");
    expect(created.published).toBe(false);

    stdout = "";
    await runCli("publish", "n1", "--json");
    expect(process.exitCode).toBe(0);
    const publishedResult = JSON.parse(stdout) as {
      article: { status: string; url: string };
      already_published: boolean;
    };
    expect(publishedResult.article.status).toBe("published");
    expect(publishedResult.article.url).toBe("https://note.com/writer/n/n1");
    expect(publishedResult.already_published).toBe(false);

    stdout = "";
    await runCli("preview", "n1", "--json");
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      key: "n1",
      url: "https://note.com/preview/n1?prev_access_key=preview-token",
    });

    published = false;
    stdout = "";
    await runCli("delete", "n1", "--yes", "--json");
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ deleted: true, article: { key: "n1" } });
  });

  it("checks auth status over HTTP", async () => {
    await runCli("auth", "status", "--json");
    expect(process.exitCode).toBe(0);
    const output = JSON.parse(stdout) as { authenticated: boolean; user: { urlname: string } };
    expect(output.authenticated).toBe(true);
    expect(output.user.urlname).toBe("writer");
    expect(stdout).not.toContain("secret-session");
    expect(stdout).not.toContain("secret-xsrf");
    expect(stderr).toBe("");
  });

  it("uploads a body image as multipart form data", async () => {
    const imageDir = await mkdtemp(join(tmpdir(), "notecli-image-e2e-"));
    const imagePath = join(imageDir, "pixel.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      await runCli("image", "n1", imagePath, "--json");
      expect(process.exitCode).toBe(0);
      const output = JSON.parse(stdout) as {
        url: string;
        kind: string;
        markdown: string;
      };
      expect(output.url).toBe("https://example.com/pixel.png");
      expect(output.kind).toBe("body");
      expect(output.markdown).toContain("![pixel](https://example.com/pixel.png)");
    } finally {
      await rm(imageDir, { recursive: true, force: true });
    }
  });
});
