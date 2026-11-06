import TurndownService from "turndown";

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  service.addRule("noteFigureImage", {
    filter: (node) =>
      node.nodeName === "FIGURE" &&
      Boolean((node as HTMLElement).querySelector("img")),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const image = element.querySelector("img");
      if (!image) {
        return "";
      }
      const src = image.getAttribute("src") ?? "";
      const alt = image.getAttribute("alt") ?? "";
      const caption = element.querySelector("figcaption")?.textContent?.trim() ?? "";
      const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : "";
      return `\n\n![${alt}](${src}${title})\n\n`;
    },
  });

  service.addRule("noteFigureQuote", {
    filter: (node) =>
      node.nodeName === "FIGURE" &&
      Boolean((node as HTMLElement).querySelector("blockquote")),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const blockquote = element.querySelector("blockquote");
      if (!blockquote) {
        return "";
      }

      const inner = service.turndown(blockquote.innerHTML).trim();
      const quoted = inner
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");

      const captionElement = element.querySelector("figcaption");
      const caption = captionElement
        ? service.turndown(captionElement.innerHTML).trim()
        : "";

      return `\n\n${quoted}${caption ? `\n> — ${caption}` : ""}\n\n`;
    },
  });

  service.addRule("noteFigureEmbed", {
    filter: (node) =>
      node.nodeName === "FIGURE" &&
      Boolean((node as HTMLElement).getAttribute("data-src")),
    replacement: (_content, node) => {
      const url = (node as HTMLElement).getAttribute("data-src") ?? "";
      return url ? `\n\n${url}\n\n` : "";
    },
  });

  service.addRule("noteTableOfContents", {
    filter: (node) => {
      const name = node.nodeName.toLowerCase();
      if (name === "table-of-contents") {
        return true;
      }
      return (
        node.nodeType === 1 &&
        (node as HTMLElement).classList?.contains("TableOfContents") === true
      );
    },
    replacement: () => "\n\n[TOC]\n\n",
  });

  service.addRule("noteLineBreak", {
    filter: "br",
    replacement: () => "\n",
  });

  return service;
}

const turndown = createTurndown();

function preprocessHtml(html: string): string {
  let result = html;

  // note.com wraps list-item text in <p>. Flatten simple items so Turndown
  // emits compact Markdown lists instead of blank lines between every item.
  result = result.replace(
    /<li([^>]*)>\s*<p([^>]*)>([\s\S]*?)<\/p>\s*<\/li>/gi,
    (match, liAttrs: string, _pAttrs: string, content: string) => {
      if (/<(?:p|ul|ol|blockquote|pre|figure|div|table)\b/i.test(content)) {
        return match;
      }
      return `<li${liAttrs}>${content}</li>`;
    }
  );

  // Turndown skips empty custom elements, so turn empty TOC elements into a
  // text marker before conversion.
  result = result.replace(
    /<table-of-contents\b[^>]*>[\s\S]*?<\/table-of-contents>/gi,
    "<p>zznoteclitocmarkerzz</p>"
  );
  result = result.replace(
    /<table-of-contents\b[^>]*\/?>/gi,
    "<p>zznoteclitocmarkerzz</p>"
  );

  // Empty embed figures are skipped by Turndown for the same reason.
  result = result.replace(
    /<figure\b(?=[^>]*\bdata-src="([^"]+)")[^>]*>\s*<\/figure>/gi,
    (_match, url: string) =>
      `<p>${url
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")}</p>`
  );

  return result;
}

/** Convert note.com's HTML body back into Markdown for editing. */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) {
    return "";
  }

  const markdown = turndown
    .turndown(preprocessHtml(html))
    .replace(/zznoteclitocmarkerzz/g, "[TOC]")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^(\s*)[-*+]\s{2,}(?=\S)/gm, "$1- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return markdown ? `${markdown}\n` : "";
}
