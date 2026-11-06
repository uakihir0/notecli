import type { Article, ArticleListResult } from "./articles.js";
import { writeText } from "./output.js";

function formatDate(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace("T", " ").replace(/Z$/, "").slice(0, 16);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function printArticleListText(result: ArticleListResult): void {
  if (result.articles.length === 0) {
    writeText("No articles found.");
    return;
  }

  const rows = result.articles.map((article) => ({
    key: article.key,
    status: article.status,
    updated: formatDate(article.updatedAt),
    title: truncate(article.title, 60),
  }));

  const keyWidth = Math.max(3, ...rows.map((row) => row.key.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));
  const updatedWidth = Math.max(7, ...rows.map((row) => row.updated.length));

  writeText(
    [
      `${pad("KEY", keyWidth)}  ${pad("STATUS", statusWidth)}  ${pad("UPDATED", updatedWidth)}  TITLE`,
      ...rows.map(
        (row) =>
          `${pad(row.key, keyWidth)}  ${pad(row.status, statusWidth)}  ${pad(row.updated, updatedWidth)}  ${row.title}`
      ),
    ].join("\n")
  );

  const shown = result.articles.length;
  writeText(
    `\n${shown} of ${result.total} article(s) shown${result.hasMore ? " (more available; increase --limit or --page)" : ""}.`
  );
}

export function printArticleText(
  article: Article,
  options: { html?: boolean; bodyOnly?: boolean } = {}
): void {
  if (options.bodyOnly) {
    writeText(options.html === true ? article.bodyHtml : article.body);
    return;
  }

  const lines = [
    `Title:   ${article.title}`,
    `Key:     ${article.key}`,
    `ID:      ${article.id}`,
    `Status:  ${article.status}`,
  ];
  if (article.tags.length > 0) {
    lines.push(`Tags:    ${article.tags.join(", ")}`);
  }
  if (article.url) {
    lines.push(`URL:     ${article.url}`);
  }
  lines.push(`Created: ${formatDate(article.createdAt)}`);
  lines.push(`Updated: ${formatDate(article.updatedAt)}`);
  lines.push("---");

  writeText(lines.join("\n"));
  writeText(options.html === true ? article.bodyHtml : article.body);
}

export function printCreatedText(article: Article, published: boolean): void {
  if (published) {
    writeText(`Published: "${article.title}" (${article.key})`);
  } else {
    writeText(`Created draft: "${article.title}" (${article.key})`);
  }
  if (article.url) {
    writeText(article.url);
  }
}

export function printUpdatedText(article: Article): void {
  writeText(`Updated: "${article.title}" (${article.key})`);
  if (article.url) {
    writeText(article.url);
  }
}

export function printPublishedText(article: Article, alreadyPublished: boolean): void {
  if (alreadyPublished) {
    writeText(`Already published: "${article.title}" (${article.key})`);
  } else {
    writeText(`Published: "${article.title}" (${article.key})`);
  }
  if (article.url) {
    writeText(article.url);
  }
}

export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

export function printPreviewText(url: string): void {
  writeText(url);
}

export function printImageText(
  url: string,
  markdown: string,
  kind: "body" | "eyecatch"
): void {
  writeText(`Uploaded ${kind} image: ${url}`);
  if (kind === "body") {
    writeText(`Markdown: ${markdown}`);
  }
}

export function printAuthStatusText(options: {
  authenticated: boolean;
  source?: string;
  user?: { id: string; urlname: string } | undefined;
  credentialsPath?: string;
  warnings?: string[];
}): void {
  if (!options.authenticated) {
    writeText("Not authenticated.");
    return;
  }

  const user = options.user;
  writeText(
    `Authenticated${user?.urlname ? ` as @${user.urlname}` : ""}${user?.id ? ` (id: ${user.id})` : ""}.`
  );
  if (options.source) {
    writeText(`Credential source: ${options.source}`);
  }
  if (options.source === "file" && options.credentialsPath) {
    writeText(`Credentials file: ${options.credentialsPath}`);
  }
  for (const warning of options.warnings ?? []) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}
