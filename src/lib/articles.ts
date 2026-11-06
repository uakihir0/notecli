import { ApiError, NotFoundError } from "./errors.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

export type ArticleStatus = "draft" | "published" | "private" | "deleted" | (string & {});

export interface Article {
  id: string;
  key: string;
  title: string;
  body: string;
  bodyHtml: string;
  status: ArticleStatus;
  tags: string[];
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  eyecatchImageKey?: string;
}

export interface ArticleSummary {
  id: string;
  key: string;
  title: string;
  status: ArticleStatus;
  tags: string[];
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ArticleListResult {
  articles: ArticleSummary[];
  total: number;
  page: number;
  hasMore: boolean;
}

export interface ArticleListOptions {
  status?: string;
  page?: number;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const normalized = entry.replace(/^#+/, "").trim();
      if (normalized) {
        tags.push(normalized);
      }
      continue;
    }

    if (!isRecord(entry)) {
      continue;
    }

    const hashtag = entry.hashtag;
    if (isRecord(hashtag)) {
      const name = firstString(hashtag.name);
      if (name) {
        tags.push(name.replace(/^#+/, ""));
      }
      continue;
    }

    const name = firstString(entry.name, entry.tag);
    if (name) {
      tags.push(name.replace(/^#+/, ""));
    }
  }

  return [...new Set(tags)];
}

export function normalizeTags(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  const parts = Array.isArray(value) ? value : value.split(",");
  const tags = parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim().replace(/^#+/, ""))
    .filter(Boolean);

  return [...new Set(tags)];
}

/** Parse the `data` object returned by note.com's article endpoints. */
export function parseArticle(raw: unknown, options: { defaultStatus?: string } = {}): Article {
  if (!isRecord(raw)) {
    throw new ApiError("note.com returned an unexpected article payload.");
  }

  const draft = isRecord(raw.note_draft)
    ? raw.note_draft
    : isRecord(raw.noteDraft)
      ? raw.noteDraft
      : undefined;

  const id = firstString(raw.id);
  const key = firstString(raw.key);
  if (!id || !key) {
    throw new ApiError("note.com returned an article without an id or key.", undefined, {
      response: raw,
    });
  }

  const title = firstString(raw.name, draft?.name) ?? "";
  const bodyHtml = firstString(draft?.body, raw.body) ?? "";
  const status = firstString(raw.status, options.defaultStatus) ?? "draft";

  if (status === "deleted") {
    throw new NotFoundError("The article has been deleted.", { article_key: key });
  }

  return {
    id,
    key,
    title,
    body: htmlToMarkdown(bodyHtml),
    bodyHtml,
    status,
    tags: parseTags(raw.hashtags ?? draft?.hashtags),
    ...(firstString(raw.noteUrl, raw.note_url, raw.url)
      ? { url: firstString(raw.noteUrl, raw.note_url, raw.url)! }
      : {}),
    ...(firstString(raw.created_at, raw.createdAt)
      ? { createdAt: firstString(raw.created_at, raw.createdAt)! }
      : {}),
    ...(firstString(raw.updated_at, raw.updatedAt)
      ? { updatedAt: firstString(raw.updated_at, raw.updatedAt)! }
      : {}),
    ...(firstString(raw.publish_at, raw.published_at, raw.publishedAt)
      ? { publishedAt: firstString(raw.publish_at, raw.published_at, raw.publishedAt)! }
      : {}),
    ...(firstString(raw.eyecatch_image_key, raw.eyecatchImageKey)
      ? {
          eyecatchImageKey: firstString(
            raw.eyecatch_image_key,
            raw.eyecatchImageKey
          )!,
        }
      : {}),
  };
}

export function toSummary(article: Article): ArticleSummary {
  return {
    id: article.id,
    key: article.key,
    title: article.title,
    status: article.status,
    tags: article.tags,
    ...(article.url ? { url: article.url } : {}),
    ...(article.createdAt ? { createdAt: article.createdAt } : {}),
    ...(article.updatedAt ? { updatedAt: article.updatedAt } : {}),
  };
}

export function parseArticleList(
  response: unknown,
  options: { page: number; limit: number; status?: string }
): ArticleListResult {
  if (!isRecord(response)) {
    throw new ApiError("note.com returned an unexpected article list payload.");
  }

  const data = isRecord(response.data) ? response.data : {};
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const articles: ArticleSummary[] = [];

  for (const note of notes) {
    try {
      articles.push(toSummary(parseArticle(note)));
    } catch (error) {
      if (error instanceof ApiError || error instanceof NotFoundError) {
        continue;
      }
      throw error;
    }
  }

  return {
    articles: articles.slice(0, options.limit),
    total: typeof data.totalCount === "number" ? data.totalCount : articles.length,
    page: options.page,
    hasMore: data.isLastPage === false,
  };
}

export function bodyLength(html: string): number {
  return Array.from(html).length;
}
