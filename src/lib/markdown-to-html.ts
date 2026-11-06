import { randomUUID } from "node:crypto";

import MarkdownIt from "markdown-it";

import { generateEmbedHtml, getEmbedService } from "./embeds.js";

const md = new MarkdownIt().enable("strikethrough");

const TOC_PATTERN = /^\[TOC\]$/gm;
const TOC_PLACEHOLDER = "§§TOC§§";

const STOCK_JP_PATTERN = /^\^(\d{4,5})$/gm;
const STOCK_US_PATTERN = /^\$([A-Z]+)$/gm;

const ALIGN_CENTER_PATTERN = /^->(.+)<-$/gm;
const ALIGN_RIGHT_PATTERN = /^->(.+)$/gm;
const ALIGN_LEFT_PATTERN = /^<-(.+)$/gm;

const STANDALONE_URL_PATTERN = /^(https?:\/\/\S+)$/gm;

interface ProtectedBlocks {
  content: string;
  blocks: Array<[placeholder: string, original: string]>;
}

function protectCodeBlocks(content: string, prefix: string): ProtectedBlocks {
  const blocks: Array<[string, string]> = [];

  const protect = (match: string): string => {
    const placeholder = `__${prefix}_${blocks.length}__`;
    blocks.push([placeholder, match]);
    return placeholder;
  };

  let protectedContent = content.replace(/```[\s\S]*?```/g, protect);
  protectedContent = protectedContent.replace(/`[^`]+`/g, protect);
  return { content: protectedContent, blocks };
}

function restoreCodeBlocks(content: string, blocks: Array<[string, string]>): string {
  let result = content;
  for (const [placeholder, original] of blocks) {
    result = result.split(placeholder).join(original);
  }
  return result;
}

function transformOutsideCode(
  content: string,
  prefix: string,
  transform: (value: string) => string
): string {
  const protectedBlocks = protectCodeBlocks(content, prefix);
  return restoreCodeBlocks(transform(protectedBlocks.content), protectedBlocks.blocks);
}

function convertToc(content: string): string {
  return transformOutsideCode(content, "TOC", (value) => {
    let replaced = false;
    return value.replace(TOC_PATTERN, () => {
      if (!replaced) {
        replaced = true;
        return TOC_PLACEHOLDER;
      }
      return "";
    });
  });
}

function convertStockNotation(content: string): string {
  return transformOutsideCode(content, "STOCK", (value) =>
    value
      .replace(STOCK_JP_PATTERN, "https://money.note.com/companies/$1")
      .replace(STOCK_US_PATTERN, "https://money.note.com/us-companies/$1")
  );
}

function convertTextAlignment(content: string): string {
  return transformOutsideCode(content, "ALIGN", (value) =>
    value
      .replace(ALIGN_CENTER_PATTERN, "§§ALIGN_CENTER§§$1§§/ALIGN§§")
      .replace(ALIGN_RIGHT_PATTERN, "§§ALIGN_RIGHT§§$1§§/ALIGN§§")
      .replace(ALIGN_LEFT_PATTERN, "§§ALIGN_LEFT§§$1§§/ALIGN§§")
  );
}

function convertImagesToNoteFormat(html: string): string {
  const imageInParagraph =
    /<p>\s*<img\s+src="([^"]+)"\s+alt="([^"]*)"(?:\s+title="([^"]*)")?\s*\/?>\s*<\/p>/gi;

  return html.replace(imageInParagraph, (_match, src: string, alt: string, caption?: string) => {
    const elementId = randomUUID();
    return (
      `<figure name="${elementId}" id="${elementId}">` +
      `<img src="${src}" alt="${alt}" width="620" height="457" ` +
      `contenteditable="false" draggable="false">` +
      `<figcaption>${caption ?? ""}</figcaption></figure>`
    );
  });
}

interface LiEdit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Wrap direct text content of <li> in <p> because note.com's ProseMirror
 * editor expects list items to contain block content. Nested lists and
 * already-wrapped items are left alone.
 */
function wrapListItemContent(html: string): string {
  const tagPattern = /<li\b[^>]*>|<\/li>/gi;
  const stack: Array<{
    contentStart: number;
    hasNestedLi: boolean;
  }> = [];
  const edits: LiEdit[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    if (match[0].startsWith("</")) {
      const entry = stack.pop();
      if (!entry) {
        continue;
      }

      const content = html.slice(entry.contentStart, match.index);
      if (content.trim() === "") {
        continue;
      }

      if (entry.hasNestedLi) {
        // Wrap a leading text node before a nested list: <li>Two<ul>...
        const firstBlock = content.search(
          /<(?:ul|ol|p|blockquote|pre|figure|div|table)\b/i
        );
        if (firstBlock > 0) {
          const leading = content.slice(0, firstBlock);
          if (leading.trim() && !/<p\b/i.test(leading)) {
            edits.push({
              start: entry.contentStart,
              end: entry.contentStart + firstBlock,
              replacement: `<p>${leading.trim()}</p>`,
            });
          }
        }
        continue;
      }

      if (
        /<p\b/i.test(content) ||
        /<(?:ul|ol|blockquote|pre|figure|div|table)\b/i.test(content)
      ) {
        continue;
      }

      edits.push({
        start: entry.contentStart,
        end: match.index,
        replacement: `<p>${content.trim()}</p>`,
      });
    } else {
      if (stack.length > 0) {
        stack[stack.length - 1]!.hasNestedLi = true;
      }
      stack.push({ contentStart: tagPattern.lastIndex, hasNestedLi: false });
    }
  }

  let result = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function convertBlockquoteNewlinesToBr(html: string): string {
  return html.replace(
    /<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi,
    (blockquote) =>
      blockquote.replace(
        /<p([^>]*)>([\s\S]*?)<\/p>/gi,
        (_match, attrs: string, content: string) =>
          `<p${attrs}>${content.replace(/\n/g, "<br>")}</p>`
      )
  );
}

function addUuidToElements(html: string): string {
  const tagPattern = /<(p|h[1-6]|ul|ol|code|hr|div|span)(\s[^>]*)?>/gi;
  return html.replace(tagPattern, (full, tagName: string, attrs?: string) => {
    if (attrs && /name="/i.test(attrs)) {
      return full;
    }
    const elementId = randomUUID();
    return `<${tagName} name="${elementId}" id="${elementId}"${attrs ?? ""}>`;
  });
}

function convertTocPlaceholderToHtml(html: string): string {
  return html.replace(
    /<p\s+name="([^"]+)"\s+id="([^"]+)">§§TOC§§<\/p>/gi,
    (_match, name: string, id: string) =>
      `<table-of-contents name="${name}" id="${id}"></table-of-contents>`
  );
}

function applyTextAlignment(html: string): string {
  return html.replace(
    /<p([^>]*)>§§ALIGN_(CENTER|RIGHT|LEFT)§§([\s\S]*?)§§\/ALIGN§§<\/p>/gi,
    (_match, attrs: string, alignment: string, content: string) =>
      `<p style="text-align: ${alignment.toLowerCase()}"${attrs}>${content}</p>`
  );
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function extractCitation(blockquoteContent: string): {
  content: string;
  figcaption: string;
} {
  const citationPattern = /(?:<br\s*\/?>)?—\s+([^<]+?)(?=<\/p>|$)/i;
  const match = citationPattern.exec(blockquoteContent);
  if (!match) {
    return { content: blockquoteContent, figcaption: "" };
  }

  const citation = (match[1] ?? "").trim();
  if (!citation) {
    return { content: blockquoteContent, figcaption: "" };
  }

  const content = blockquoteContent.replace(match[0], "");
  const urlMatch = /^(.+?)\s+\((https?:\/\/\S+)\)$/.exec(citation);
  const figcaption = urlMatch
    ? `<a href="${escapeHtmlAttribute(urlMatch[2]!)}">${escapeHtmlText(urlMatch[1]!.trim())}</a>`
    : escapeHtmlText(citation);

  return { content, figcaption };
}

function convertBlockquotesToNoteFormat(html: string): string {
  return html.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_match, inner: string) => {
      const elementId = randomUUID();
      const { content, figcaption } = extractCitation(inner);
      return (
        `<figure name="${elementId}" id="${elementId}">` +
        `<blockquote>${content}</blockquote>` +
        `<figcaption>${figcaption}</figcaption></figure>`
      );
    }
  );
}

function convertStandaloneEmbedUrls(html: string): string {
  const pattern =
    /(?<!<li>)<p\s+name="[^"]+"\s+id="[^"]+">(\s*)(https?:\/\/\S+?)(\s*)<\/p>/gi;

  return html.replace(pattern, (full, _leading: string, url: string) => {
    if (!getEmbedService(url)) {
      return full;
    }
    return generateEmbedHtml(url);
  });
}

function convertCodeBlocksToNoteFormat(html: string): string {
  const preBlocks: string[] = [];

  let result = html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (_match, _attrs, content: string) => {
    const elementId = randomUUID();
    const withoutLanguageClass = content.replace(
      /<code[^>]*class="language-[^"]*"[^>]*>/gi,
      "<code>"
    );
    const block =
      `<pre name="${elementId}" id="${elementId}" class="codeBlock">` +
      `${withoutLanguageClass}</pre>`;
    preBlocks.push(block);
    return `__PRE_BLOCK_${preBlocks.length - 1}__`;
  });

  result = result.replace(/\n/g, "");
  for (let index = 0; index < preBlocks.length; index += 1) {
    result = result.split(`__PRE_BLOCK_${index}__`).join(preBlocks[index]!);
  }
  return result;
}

export function hasEmbedUrl(content: string): boolean {
  for (const match of content.matchAll(STANDALONE_URL_PATTERN)) {
    if (getEmbedService(match[1]!)) {
      return true;
    }
  }
  return false;
}

/**
 * Convert Markdown to the HTML shape expected by note.com's editor/API.
 *
 * Features ported from note-mcp: element UUIDs, note-style image figures,
 * TOC placeholders, blockquote citations, text alignment, stock notation,
 * URL embeds, and code blocks.
 */
export function markdownToNoteHtml(markdown: string): string {
  if (!markdown.trim()) {
    return "";
  }

  let content = markdown;
  content = convertToc(content);
  content = convertStockNotation(content);
  content = convertTextAlignment(content);

  let html = md.render(content);
  html = convertImagesToNoteFormat(html);
  html = wrapListItemContent(html);
  html = convertBlockquoteNewlinesToBr(html);
  html = addUuidToElements(html);
  html = convertTocPlaceholderToHtml(html);
  html = applyTextAlignment(html);
  html = convertBlockquotesToNoteFormat(html);
  html = convertStandaloneEmbedUrls(html);
  html = convertCodeBlocksToNoteFormat(html);

  return html;
}
