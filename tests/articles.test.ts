import { describe, expect, it } from "vitest";

import {
  bodyLength,
  normalizeTags,
  parseArticle,
  parseArticleList,
} from "../src/lib/articles.js";

describe("parseArticle", () => {
  it("reads draft HTML, tags, and URLs from the API payload", () => {
    const article = parseArticle({
      id: 123,
      key: "n123",
      name: "Title",
      body: "",
      status: "draft",
      note_draft: {
        body: '<h2 name="x" id="x">Heading</h2><p name="y" id="y">Body</p>',
      },
      hashtags: [{ hashtag: { name: "alpha" } }, "#beta"],
      noteUrl: "https://note.com/writer/n/n123",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    });

    expect(article.title).toBe("Title");
    expect(article.body).toContain("## Heading");
    expect(article.body).toContain("Body");
    expect(article.tags).toEqual(["alpha", "beta"]);
    expect(article.url).toBe("https://note.com/writer/n/n123");
    expect(article.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("falls back to camelCase noteDraft fields", () => {
    const article = parseArticle({
      id: "1",
      key: "n1",
      noteDraft: { name: "Draft title", body: "<p>Hello</p>" },
      status: "draft",
    });
    expect(article.title).toBe("Draft title");
    expect(article.bodyHtml).toBe("<p>Hello</p>");
  });

  it("rejects deleted articles as not found", () => {
    expect(() =>
      parseArticle({ id: "1", key: "n1", name: "Gone", status: "deleted" })
    ).toThrow(/deleted/);
  });
});

describe("parseArticleList", () => {
  it("maps notes and pagination metadata", () => {
    const result = parseArticleList(
      {
        data: {
          notes: [
            { id: 1, key: "n1", name: "One", status: "draft" },
            { id: 2, key: "n2", name: "Two", status: "published" },
          ],
          totalCount: 12,
          isLastPage: false,
        },
      },
      { page: 1, limit: 10 }
    );

    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]?.title).toBe("One");
    expect(result.total).toBe(12);
    expect(result.hasMore).toBe(true);
  });

  it("skips invalid entries instead of failing the whole list", () => {
    const result = parseArticleList(
      {
        data: {
          notes: [
            { id: 1, key: "n1", name: "Valid", status: "draft" },
            { id: 2, name: "No key", status: "draft" },
          ],
          totalCount: 2,
          isLastPage: true,
        },
      },
      { page: 1, limit: 10 }
    );
    expect(result.articles).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("normalizes tags", () => {
    expect(normalizeTags(" #alpha, beta ,#alpha ")).toEqual(["alpha", "beta"]);
    expect(normalizeTags(["#one", "two"])).toEqual(["one", "two"]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("counts Unicode code points for body_length", () => {
    expect(bodyLength("<p>日本</p>")).toBe(9);
    expect(bodyLength("<p>😀</p>")).toBe(8);
  });
});
