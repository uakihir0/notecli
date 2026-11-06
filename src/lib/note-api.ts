import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { NoteApiClient } from "./api.js";
import {
  bodyLength,
  normalizeTags,
  parseArticle,
  parseArticleList,
  type Article,
  type ArticleListOptions,
  type ArticleListResult,
} from "./articles.js";
import { hasEmbedHtml, resolveEmbedKeys } from "./embeds.js";
import { ApiError, InputError, NotFoundError } from "./errors.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { markdownToNoteHtml } from "./markdown-to-html.js";

export interface ArticleMutationResult {
  article: Article;
  warnings: string[];
}

export interface PublishResult extends ArticleMutationResult {
  alreadyPublished: boolean;
}

export interface PreviewResult {
  key: string;
  url: string;
}

export type ImageKind = "body" | "eyecatch";

export interface UploadImageResult {
  url: string;
  key?: string;
  kind: ImageKind;
  markdown: string;
}

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dataOf(response: unknown, context: string): Record<string, unknown> {
  if (!isRecord(response) || !isRecord(response.data)) {
    throw new ApiError(`note.com returned an unexpected response while ${context}.`);
  }
  return response.data;
}

function ensureDraftSaved(response: unknown): void {
  const data = dataOf(response, "saving the draft");
  if (data.result === false) {
    throw new ApiError("note.com refused to save the draft.");
  }
}

function draftHashtags(tags: string[]): Array<{ hashtag: { name: string } }> {
  return tags.map((tag) => ({ hashtag: { name: tag } }));
}

function publishHashtags(tags: string[]): string[] {
  return tags.map((tag) => `#${tag}`);
}

function articlePayload(
  title: string,
  html: string,
  tags: string[]
): Record<string, unknown> {
  return {
    name: title,
    body: html,
    body_length: bodyLength(html),
    index: false,
    is_lead_form: false,
    ...(tags.length > 0 ? { hashtags: draftHashtags(tags) } : {}),
  };
}

function createPayload(title: string, tags: string[]): Record<string, unknown> {
  return {
    name: title,
    index: false,
    is_lead_form: false,
    ...(tags.length > 0 ? { hashtags: draftHashtags(tags) } : {}),
  };
}

async function resolveNumericId(client: NoteApiClient, key: string): Promise<string> {
  if (/^\d+$/.test(key)) {
    return key;
  }
  const response = await client.get<unknown>(`/v3/notes/${key}`);
  const data = dataOf(response, "resolving the numeric article ID");
  const id = data.id;
  if (id === undefined || id === null || String(id) === "") {
    throw new ApiError("note.com did not return a numeric article ID.", undefined, {
      article_key: key,
    });
  }
  return String(id);
}

export async function getArticleRaw(
  client: NoteApiClient,
  key: string
): Promise<Article> {
  const response = await client.get<unknown>(`/v3/notes/${key}`);
  return parseArticle(dataOf(response, "fetching the article"));
}

export async function listArticles(
  client: NoteApiClient,
  options: ArticleListOptions = {}
): Promise<ArticleListResult> {
  const limit = Math.max(1, options.limit ?? 10);
  const startPage = Math.max(1, options.page ?? 1);
  const status = options.status;
  const collected: ArticleListResult["articles"] = [];

  let page = startPage;
  let total = 0;
  let hasMore = false;

  while (collected.length < limit) {
    const response = await client.get<unknown>("/v2/note_list/contents", {
      page,
      ...(status ? { publish_status: status } : {}),
    });
    const parsed = parseArticleList(response, { page, limit: 10, ...(status ? { status } : {}) });
    collected.push(...parsed.articles);
    total = parsed.total;
    hasMore = parsed.hasMore;

    if (!parsed.hasMore || parsed.articles.length === 0) {
      break;
    }
    page += 1;
  }

  return {
    articles: collected.slice(0, limit),
    total,
    page: startPage,
    hasMore,
  };
}

export async function createDraft(
  client: NoteApiClient,
  input: { title: string; markdown: string; tags?: string[] }
): Promise<ArticleMutationResult> {
  const tags = normalizeTags(input.tags);
  const created = dataOf(
    await client.post<unknown>("/v1/text_notes", createPayload(input.title, tags)),
    "creating the draft"
  );

  const id = created.id;
  const key = created.key;
  if (id === undefined || id === null || key === undefined || key === null) {
    throw new ApiError("note.com did not return an article ID and key.");
  }

  let html = markdownToNoteHtml(input.markdown);
  const warnings: string[] = [];

  if (hasEmbedHtml(html)) {
    const resolved = await resolveEmbedKeys(client, html, String(key));
    html = resolved.html;
    warnings.push(...resolved.warnings);
  }

  ensureDraftSaved(
    await client.post<unknown>(
      `/v1/text_notes/draft_save?id=${encodeURIComponent(String(id))}&is_temp_saved=true`,
      articlePayload(input.title, html, tags)
    )
  );

  return {
    article: {
      id: String(id),
      key: String(key),
      title: input.title,
      body: htmlToMarkdown(html),
      bodyHtml: html,
      status: "draft",
      tags,
    },
    warnings,
  };
}

export async function updateArticle(
  client: NoteApiClient,
  key: string,
  input: { title?: string; markdown?: string; tags?: string[] }
): Promise<ArticleMutationResult> {
  const existing = await getArticleRaw(client, key);
  const title = input.title ?? existing.title;
  const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;

  let html = existing.bodyHtml;
  let bodyMarkdown = existing.body;
  const warnings: string[] = [];

  if (input.markdown !== undefined) {
    html = markdownToNoteHtml(input.markdown);
    bodyMarkdown = input.markdown;
    if (hasEmbedHtml(html)) {
      const resolved = await resolveEmbedKeys(client, html, key);
      html = resolved.html;
      warnings.push(...resolved.warnings);
    }
  }

  ensureDraftSaved(
    await client.post<unknown>(
      `/v1/text_notes/draft_save?id=${existing.id}&is_temp_saved=true`,
      articlePayload(title, html, tags)
    )
  );

  const updated = await getArticleRaw(client, key).catch(() => null);
  return {
    article:
      updated ?? {
        ...existing,
        title,
        body: bodyMarkdown,
        bodyHtml: html,
        tags,
      },
    warnings,
  };
}

export async function publishArticle(
  client: NoteApiClient,
  key: string,
  tags?: string[]
): Promise<PublishResult> {
  const existing = await getArticleRaw(client, key);
  const finalTags = tags !== undefined ? normalizeTags(tags) : existing.tags;

  if (existing.status === "published" && tags === undefined) {
    return { article: existing, warnings: [], alreadyPublished: true };
  }

  const payload = {
    name: existing.title,
    free_body: existing.bodyHtml,
    body_length: bodyLength(existing.bodyHtml),
    status: "published",
    index: false,
    ...(finalTags.length > 0 ? { hashtags: publishHashtags(finalTags) } : {}),
  };

  const response = await client.put<unknown>(`/v1/text_notes/${existing.id}`, payload);
  const data = dataOf(response, "publishing the article");
  if (data.result === false) {
    throw new ApiError("note.com refused to publish the article.", undefined, {
      article_key: key,
    });
  }

  const published = await getArticleRaw(client, key);
  if (published.status !== "published") {
    throw new ApiError(
      `The publish request succeeded, but the article status is still "${published.status}".`,
      undefined,
      { article_key: key }
    );
  }

  return {
    article: { ...published, tags: finalTags.length > 0 ? finalTags : published.tags },
    warnings: [],
    alreadyPublished: false,
  };
}

export async function deleteDraft(
  client: NoteApiClient,
  key: string
): Promise<Article> {
  const existing = await getArticleRaw(client, key);
  if (existing.status === "published") {
    throw new InputError(
      "Published articles cannot be deleted by this CLI. Only drafts can be deleted."
    );
  }
  if (existing.status === "deleted") {
    throw new NotFoundError("The article has already been deleted.", { article_key: key });
  }

  await client.delete<unknown>(`/v1/notes/n/${key}`);
  return existing;
}

export async function getPreviewUrl(
  client: NoteApiClient,
  key: string
): Promise<PreviewResult> {
  const response = await client.post<unknown>(`/v2/notes/${key}/access_tokens`, { key });
  const data = dataOf(response, "creating the preview URL");
  const token = data.preview_access_token;
  if (token === undefined || token === null || String(token) === "") {
    throw new ApiError(
      "note.com did not return a preview access token. The article may already be published.",
      undefined,
      { article_key: key }
    );
  }

  return {
    key,
    url: `https://note.com/preview/${key}?prev_access_key=${encodeURIComponent(String(token))}`,
  };
}

export async function uploadImage(
  client: NoteApiClient,
  key: string,
  filePath: string,
  kind: ImageKind
): Promise<UploadImageResult> {
  const absolutePath = resolve(filePath);
  const extension = extname(absolutePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    throw new InputError(
      `Unsupported image format "${extension || "(none)"}". Use jpg, jpeg, png, gif, or webp.`
    );
  }

  const info = await stat(absolutePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new InputError(`Image file not found: ${absolutePath}`);
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new InputError(
      `Image is too large (${info.size} bytes). The maximum is ${MAX_IMAGE_BYTES} bytes (10 MiB).`
    );
  }

  const numericId = await resolveNumericId(client, key);
  const buffer = await readFile(absolutePath);
  const form = new FormData();
  form.append("note_id", numericId);
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], {
      type: CONTENT_TYPES[extension] ?? "application/octet-stream",
    }),
    basename(absolutePath)
  );

  const response = await client.postForm<unknown>("/v1/image_upload/note_eyecatch", form);
  const data = dataOf(response, "uploading the image");
  const url = data.url;
  if (url === undefined || url === null || String(url) === "") {
    throw new ApiError("note.com did not return an uploaded image URL.");
  }

  const imageUrl = String(url);
  const imageKey = data.key ? String(data.key) : undefined;
  const alt = basename(absolutePath, extension);

  return {
    url: imageUrl,
    ...(imageKey ? { key: imageKey } : {}),
    kind,
    markdown: `![${alt}](${imageUrl})`,
  };
}
