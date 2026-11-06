import type { Article, ArticleSummary } from "./articles.js";

export function articleToJson(article: Article): Record<string, unknown> {
  return {
    id: article.id,
    key: article.key,
    title: article.title,
    status: article.status,
    tags: article.tags,
    body: article.body,
    body_html: article.bodyHtml,
    ...(article.url ? { url: article.url } : {}),
    ...(article.createdAt ? { created_at: article.createdAt } : {}),
    ...(article.updatedAt ? { updated_at: article.updatedAt } : {}),
    ...(article.publishedAt ? { published_at: article.publishedAt } : {}),
    ...(article.eyecatchImageKey ? { eyecatch_image_key: article.eyecatchImageKey } : {}),
  };
}

export function summaryToJson(article: ArticleSummary): Record<string, unknown> {
  return {
    id: article.id,
    key: article.key,
    title: article.title,
    status: article.status,
    tags: article.tags,
    ...(article.url ? { url: article.url } : {}),
    ...(article.createdAt ? { created_at: article.createdAt } : {}),
    ...(article.updatedAt ? { updated_at: article.updatedAt } : {}),
  };
}
