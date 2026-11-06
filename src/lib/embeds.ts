import { randomUUID } from "node:crypto";

import type { NoteApiClient } from "./api.js";
import { ApiError, InputError } from "./errors.js";

export type EmbedService =
  | "youtube"
  | "twitter"
  | "note"
  | "gist"
  | "githubRepository"
  | "googlepresentation"
  | "speakerdeck"
  | "oembed"
  | "external-article";

interface EmbedPattern {
  pattern: RegExp;
  service: EmbedService;
}

const EMBED_PATTERNS: EmbedPattern[] = [
  { pattern: /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+$/, service: "youtube" },
  { pattern: /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/\d+$/, service: "twitter" },
  { pattern: /^https?:\/\/note\.com\/\w+\/n\/\w+$/, service: "note" },
  { pattern: /^https?:\/\/gist\.github\.com\/[\w-]+\/[\w]+\/?(?:#[\w-]+)?$/, service: "gist" },
  { pattern: /^https?:\/\/(?:www\.)?github\.com\/[\w-]+\/[\w.-]+\/?$/, service: "githubRepository" },
  {
    pattern: /^https?:\/\/docs\.google\.com\/presentation\/d\/[\w-]+(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/,
    service: "googlepresentation",
  },
  { pattern: /^https?:\/\/speakerdeck\.com\/[\w-]+\/[\w-]+$/, service: "speakerdeck" },
  {
    pattern: /^https?:\/\/money\.note\.com\/(companies|us-companies|indices|investments)\/[\w-]+\/?$/,
    service: "oembed",
  },
  { pattern: /^https?:\/\/zenn\.dev\/[\w-]+\/articles\/[\w-]+$/, service: "external-article" },
  { pattern: /^https?:\/\/qiita\.com\/[\w-]+\/items\/[\w]+$/, service: "external-article" },
  {
    pattern: /^https?:\/\/(?!www\.)([\w-]+)\.connpass\.com\/event\/\d+\/?$/,
    service: "external-article",
  },
];

export function getEmbedService(url: string): EmbedService | null {
  for (const { pattern, service } of EMBED_PATTERNS) {
    if (pattern.test(url)) {
      return service;
    }
  }
  return null;
}

export function isEmbedUrl(url: string): boolean {
  return getEmbedService(url) !== null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function generateEmbedHtml(
  url: string,
  service?: EmbedService | null,
  embedKey?: string
): string {
  const detected = service ?? getEmbedService(url);
  if (!detected) {
    throw new InputError(`Unsupported embed URL: ${url}`);
  }

  const elementId = randomUUID();
  const key = embedKey ?? `emb${randomUUID().replace(/-/g, "").slice(0, 13)}`;
  const escapedUrl = escapeHtmlAttribute(url);

  return (
    `<figure name="${elementId}" id="${elementId}" ` +
    `data-src="${escapedUrl}" ` +
    `embedded-service="${detected}" ` +
    `embedded-content-key="${key}" ` +
    `contenteditable="false"></figure>`
  );
}

interface EmbedKeyResponse {
  data?: {
    key?: string;
    html_for_embed?: string;
    embedded_content?: {
      key?: string;
      html_for_embed?: string;
    };
  };
}

export async function fetchEmbedKey(
  client: NoteApiClient,
  url: string,
  articleKey: string
): Promise<string> {
  const service = getEmbedService(url);
  if (!service) {
    throw new InputError(`Unsupported embed URL: ${url}`);
  }

  let response: EmbedKeyResponse;

  if (service === "note") {
    response = await client.post<EmbedKeyResponse>("/v1/embed", {
      url,
      embeddable_key: articleKey,
      embeddable_type: "Note",
    });
    const embedded = response.data?.embedded_content;
    const key = embedded?.key ?? response.data?.key;
    if (!key) {
      throw new ApiError(
        "Failed to register the note.com embed: the API response did not include a key.",
        undefined,
        { url, article_key: articleKey }
      );
    }
    return key;
  }

  response = await client.get<EmbedKeyResponse>("/v2/embed_by_external_api", {
    url,
    service,
    embeddable_key: articleKey,
    embeddable_type: "Note",
  });
  const key = response.data?.key;
  if (!key) {
    throw new ApiError(
      `Failed to register the ${service} embed: the API response did not include a key.`,
      undefined,
      { url, article_key: articleKey }
    );
  }
  return key;
}

const EMBED_FIGURE_PATTERN =
  /<figure\s+(?=[^>]*?data-src="([^"]+)")(?=[^>]*?embedded-content-key="([^"]+)")[^>]*>/gi;

export function hasEmbedHtml(html: string): boolean {
  return /embedded-content-key="/i.test(html);
}

/**
 * Register every embed in the HTML and replace placeholder keys with the
 * server-issued keys required for iframe rendering.
 *
 * Individual failures are tolerated: the article is still saved, and the
 * caller can inspect `warnings` to report problematic embeds.
 */
export async function resolveEmbedKeys(
  client: NoteApiClient,
  html: string,
  articleKey: string
): Promise<{ html: string; warnings: string[] }> {
  const matches = [...html.matchAll(EMBED_FIGURE_PATTERN)];
  if (matches.length === 0) {
    return { html, warnings: [] };
  }

  let result = html;
  const warnings: string[] = [];

  for (const match of matches) {
    const tag = match[0];
    const dataSrc = match[1];
    const oldKey = match[2];
    if (!dataSrc || !oldKey) {
      continue;
    }

    const url = unescapeHtmlAttribute(dataSrc);
    if (!getEmbedService(url)) {
      warnings.push(`Skipped unsupported embed URL: ${url}`);
      continue;
    }

    try {
      const serverKey = await fetchEmbedKey(client, url, articleKey);
      result = result.replace(tag, tag.replace(`embedded-content-key="${oldKey}"`, `embedded-content-key="${serverKey}"`));
    } catch (error) {
      warnings.push(
        `Could not register embed ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { html: result, warnings };
}
