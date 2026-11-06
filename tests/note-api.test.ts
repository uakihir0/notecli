import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteApiClient } from "../src/lib/api.js";
import { ApiError, InputError } from "../src/lib/errors.js";
import {
  createDraft,
  deleteDraft,
  getPreviewUrl,
  listArticles,
  publishArticle,
  updateArticle,
  uploadImage,
} from "../src/lib/note-api.js";

function asClient(partial: Record<string, unknown>): NoteApiClient {
  return partial as unknown as NoteApiClient;
}

const draftRaw = {
  data: {
    id: 123,
    key: "n123",
    name: "Draft",
    body: "",
    status: "draft",
    hashtags: [{ hashtag: { name: "existing" } }],
    note_draft: { body: '<h1 name="a" id="a">Title</h1><p name="b" id="b">Body</p>' },
  },
};

const publishedRaw = {
  data: {
    ...draftRaw.data,
    status: "published",
    noteUrl: "https://note.com/writer/n/n123",
  },
};

describe("listArticles", () => {
  it("paginates until the requested limit is reached", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          notes: Array.from({ length: 10 }, (_, index) => ({
            id: index + 1,
            key: `n${index + 1}`,
            name: `Note ${index + 1}`,
            status: "draft",
          })),
          totalCount: 15,
          isLastPage: false,
        },
      })
      .mockResolvedValueOnce({
        data: {
          notes: Array.from({ length: 5 }, (_, index) => ({
            id: index + 11,
            key: `n${index + 11}`,
            name: `Note ${index + 11}`,
            status: "draft",
          })),
          totalCount: 15,
          isLastPage: false,
        },
      });

    const result = await listArticles(asClient({ get }), { limit: 12, status: "draft" });
    expect(result.articles).toHaveLength(12);
    expect(result.total).toBe(15);
    expect(result.hasMore).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]![1]).toEqual({ page: 1, publish_status: "draft" });
  });

  it("verifies the session when the list is empty", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { notes: [], totalCount: 0, isLastPage: true },
    });
    const getCurrentUser = vi.fn().mockResolvedValue({ id: "1", urlname: "writer" });

    const result = await listArticles(asClient({ get, getCurrentUser }));

    expect(result.articles).toEqual([]);
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });
});

describe("createDraft", () => {
  it("creates the article, saves note-compatible HTML, and returns the key", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 123, key: "n123" } })
      .mockResolvedValueOnce({ data: { result: true } });

    const result = await createDraft(asClient({ post }), {
      title: "Hello",
      markdown: "# Hello\n\nWorld",
      tags: ["alpha"],
    });

    expect(result.article.id).toBe("123");
    expect(result.article.key).toBe("n123");
    expect(result.article.status).toBe("draft");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toBe("/v1/text_notes");

    const savePath = post.mock.calls[1]![0] as string;
    expect(savePath).toContain("/v1/text_notes/draft_save?id=123");
    const payload = post.mock.calls[1]![1] as Record<string, unknown>;
    expect(String(payload.body)).toContain("<h1 ");
    expect(payload.hashtags).toEqual([{ hashtag: { name: "alpha" } }]);
    expect(payload.body_length).toBeGreaterThan(0);
  });

  it("registers embed keys before saving", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 123, key: "n123" } })
      .mockResolvedValue({ data: { result: true } });
    const get = vi.fn().mockResolvedValue({ data: { key: "emb-server" } });

    const result = await createDraft(asClient({ post, get }), {
      title: "Video",
      markdown: "https://youtu.be/dQw4w9WgXcQ",
    });

    const payload = post.mock.calls[1]![1] as Record<string, unknown>;
    expect(String(payload.body)).toContain('embedded-content-key="emb-server"');
    expect(result.warnings).toEqual([]);
  });

  it("reports the draft key when saving the body fails", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 123, key: "n123" } })
      .mockRejectedValueOnce(new ApiError("save failed"));

    await expect(
      createDraft(asClient({ post }), { title: "Hello", markdown: "# Hello" })
    ).rejects.toThrow(/n123.*saving its body failed/);
  });
});

describe("updateArticle", () => {
  it("preserves the stored HTML when only the title changes", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(draftRaw)
      .mockResolvedValueOnce({
        data: { ...draftRaw.data, name: "New title" },
      });
    const post = vi.fn().mockResolvedValue({ data: { result: true } });

    const result = await updateArticle(asClient({ get, post }), "n123", {
      title: "New title",
    });

    const payload = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.name).toBe("New title");
    expect(payload.body).toBe(draftRaw.data.note_draft.body);
    expect(payload.hashtags).toEqual([{ hashtag: { name: "existing" } }]);
    expect(result.article.title).toBe("New title");
  });

  it("converts a new Markdown body", async () => {
    const get = vi.fn().mockResolvedValueOnce(draftRaw).mockResolvedValueOnce(draftRaw);
    const post = vi.fn().mockResolvedValue({ data: { result: true } });

    await updateArticle(asClient({ get, post }), "n123", {
      markdown: "## Updated",
    });

    const payload = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(String(payload.body)).toContain("<h2 ");
    expect(String(payload.body)).toContain("Updated");
  });
});

describe("publishArticle", () => {
  it("publishes with free_body and hashtag strings", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(draftRaw)
      .mockResolvedValueOnce(publishedRaw);
    const put = vi.fn().mockResolvedValue({ data: { result: true } });

    const result = await publishArticle(asClient({ get, put }), "n123", ["alpha", "#beta"]);

    expect(put.mock.calls[0]![0]).toBe("/v1/text_notes/123");
    const payload = put.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.free_body).toBe(draftRaw.data.note_draft.body);
    expect(payload.status).toBe("published");
    expect(payload.hashtags).toEqual(["#alpha", "#beta"]);
    expect(result.article.status).toBe("published");
    expect(result.alreadyPublished).toBe(false);
  });

  it("is idempotent for an already published article", async () => {
    const get = vi.fn().mockResolvedValue(publishedRaw);
    const put = vi.fn();

    const result = await publishArticle(asClient({ get, put }), "n123");
    expect(result.alreadyPublished).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("deleteDraft", () => {
  it("deletes a draft", async () => {
    const get = vi.fn().mockResolvedValue(draftRaw);
    const del = vi.fn().mockResolvedValue({});

    const result = await deleteDraft(asClient({ get, delete: del }), "n123");
    expect(result.key).toBe("n123");
    expect(del).toHaveBeenCalledWith("/v1/notes/n/n123");
  });

  it("refuses to delete a published article", async () => {
    const get = vi.fn().mockResolvedValue(publishedRaw);
    const del = vi.fn();

    await expect(deleteDraft(asClient({ get, delete: del }), "n123")).rejects.toBeInstanceOf(
      InputError
    );
    expect(del).not.toHaveBeenCalled();
  });
});

describe("getPreviewUrl", () => {
  it("builds a preview URL from the access token", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { preview_access_token: "abc123" } });

    const result = await getPreviewUrl(asClient({ post }), "n123");
    expect(result.url).toBe("https://note.com/preview/n123?prev_access_key=abc123");
    expect(post).toHaveBeenCalledWith("/v2/notes/n123/access_tokens", { key: "n123" });
  });
});

describe("uploadImage", () => {
  let tempDir: string;
  let imagePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "notecli-image-"));
    imagePath = join(tempDir, "header.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uploads a body image and returns a Markdown snippet", async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 99 } });
    const postForm = vi.fn().mockResolvedValue({
      data: { url: "https://assets.st-note.com/image.png", key: "image-key" },
    });

    const result = await uploadImage(asClient({ get, postForm }), "n123", imagePath, "body");

    expect(get).toHaveBeenCalledWith("/v3/notes/n123");
    expect(postForm.mock.calls[0]![0]).toBe("/v1/image_upload/note_eyecatch");
    const form = postForm.mock.calls[0]![1] as FormData;
    expect(form.get("note_id")).toBe("99");
    expect(result.url).toBe("https://assets.st-note.com/image.png");
    expect(result.markdown).toContain("![header](https://assets.st-note.com/image.png)");
  });

  it("rejects unsupported image extensions", async () => {
    const badPath = join(tempDir, "file.txt");
    await writeFile(badPath, "not an image");
    await expect(
      uploadImage(asClient({}), "n123", badPath, "body")
    ).rejects.toBeInstanceOf(InputError);
  });
});
