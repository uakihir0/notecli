import { describe, expect, it } from "vitest";

import { generateEmbedHtml, getEmbedService, isEmbedUrl, resolveEmbedKeys } from "../src/lib/embeds.js";
import type { NoteApiClient } from "../src/lib/api.js";

describe("embed URL detection", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube"],
    ["https://x.com/user/status/1234567890", "twitter"],
    ["https://note.com/writer/n/n1234567890ab", "note"],
    ["https://gist.github.com/user/abc123", "gist"],
    ["https://github.com/owner/repo", "githubRepository"],
    ["https://docs.google.com/presentation/d/abc123/edit", "googlepresentation"],
    ["https://speakerdeck.com/user/slide", "speakerdeck"],
    ["https://money.note.com/companies/5243", "oembed"],
    ["https://zenn.dev/user/articles/hello", "external-article"],
    ["https://qiita.com/user/items/abc", "external-article"],
    ["https://group.connpass.com/event/12345/", "external-article"],
  ])("detects %s as %s", (url, service) => {
    expect(getEmbedService(url)).toBe(service);
    expect(isEmbedUrl(url)).toBe(true);
  });

  it("returns null for unsupported URLs", () => {
    expect(getEmbedService("https://example.com/article")).toBeNull();
  });
});

describe("generateEmbedHtml", () => {
  it("generates a note.com embed figure with a placeholder key", () => {
    const html = generateEmbedHtml("https://youtu.be/dQw4w9WgXcQ");
    expect(html).toMatch(/^<figure name="[0-9a-f-]{36}" id="[0-9a-f-]{36}"/);
    expect(html).toContain('data-src="https://youtu.be/dQw4w9WgXcQ"');
    expect(html).toContain('embedded-service="youtube"');
    expect(html).toContain('embedded-content-key="emb');
  });
});

describe("resolveEmbedKeys", () => {
  it("replaces placeholder keys with server-registered keys", async () => {
    const external = generateEmbedHtml("https://youtu.be/dQw4w9WgXcQ");
    const note = generateEmbedHtml("https://note.com/writer/n/n1234567890ab");
    const html = `${external}${note}`;

    const client = {
      get: async () => ({ data: { key: "emb-server-1" } }),
      post: async () => ({
        data: { embedded_content: { key: "emb-server-2" } },
      }),
    } as unknown as NoteApiClient;

    const result = await resolveEmbedKeys(client, html, "n999");
    expect(result.html).toContain('embedded-content-key="emb-server-1"');
    expect(result.html).toContain('embedded-content-key="emb-server-2"');
    expect(result.warnings).toEqual([]);
  });

  it("keeps the placeholder and reports a warning when registration fails", async () => {
    const html = generateEmbedHtml("https://youtu.be/dQw4w9WgXcQ");
    const client = {
      get: async () => {
        throw new Error("network down");
      },
    } as unknown as NoteApiClient;

    const result = await resolveEmbedKeys(client, html, "n999");
    expect(result.html).toBe(html);
    expect(result.warnings[0]).toContain("network down");
  });
});
