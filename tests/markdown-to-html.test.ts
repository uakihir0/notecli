import { describe, expect, it } from "vitest";

import { markdownToNoteHtml } from "../src/lib/markdown-to-html.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

describe("markdownToNoteHtml", () => {
  it("returns an empty string for empty input", () => {
    expect(markdownToNoteHtml("")).toBe("");
    expect(markdownToNoteHtml("   \n")).toBe("");
  });

  it("adds note.com UUID attributes to block elements", () => {
    const html = markdownToNoteHtml("# Heading\n\nParagraph with **bold** text.");
    expect(html).toMatch(new RegExp(`<h1 name="${UUID}" id="${UUID}">Heading</h1>`));
    expect(html).toMatch(new RegExp(`<p name="${UUID}" id="${UUID}">Paragraph with <strong>bold</strong> text.</p>`));
  });

  it("converts images to note.com figure markup", () => {
    const html = markdownToNoteHtml('![Alt text](https://example.com/image.png "A caption")');
    expect(html).toContain('<figure name="');
    expect(html).toContain('<img src="https://example.com/image.png" alt="Alt text" width="620" height="457"');
    expect(html).toContain("<figcaption>A caption</figcaption>");
  });

  it("wraps list item content in paragraphs but leaves nested lists alone", () => {
    const html = markdownToNoteHtml("- One\n- Two\n  - Nested");
    expect(html).toMatch(new RegExp(`<li><p name="${UUID}" id="${UUID}">One</p></li>`));
    expect(html).toMatch(/<ul\b/);
    expect(html).toContain("Nested");
    expect(html).not.toContain("<p>One</p>");
  });

  it("converts fenced code blocks to note.com codeBlock markup", () => {
    const html = markdownToNoteHtml("```js\nconst x = 1;\n```");
    expect(html).toMatch(new RegExp(`<pre name="${UUID}" id="${UUID}" class="codeBlock">`));
    expect(html).not.toContain("language-js");
    expect(html).toContain("const x = 1;\n");
    expect(html).not.toContain("```");
  });

  it("converts [TOC] to a table-of-contents element", () => {
    const html = markdownToNoteHtml("[TOC]\n\n## Section\n\nText");
    expect(html).toMatch(
      new RegExp(`<table-of-contents name="${UUID}" id="${UUID}"></table-of-contents>`)
    );
    expect(html).not.toContain("[TOC]");
  });

  it("does not treat [TOC] inside code as a table of contents", () => {
    const html = markdownToNoteHtml("`[TOC]`\n\n[TOC]");
    expect(html).toContain("[TOC]");
    expect(html).toContain("<table-of-contents");
  });

  it("converts blockquotes with citations to figure markup", () => {
    const html = markdownToNoteHtml("> Knowledge is power\n> — Francis Bacon (https://example.com)");
    expect(html).toContain("<blockquote><p");
    expect(html).toContain('<figcaption><a href="https://example.com">Francis Bacon</a></figcaption>');
    expect(html).not.toContain("— Francis Bacon");
  });

  it("converts text alignment markers", () => {
    expect(markdownToNoteHtml("->center<-")).toContain('style="text-align: center"');
    expect(markdownToNoteHtml("->right")).toContain('style="text-align: right"');
    expect(markdownToNoteHtml("<-left")).toContain('style="text-align: left"');
  });

  it("converts standalone supported URLs to embed figures", () => {
    const html = markdownToNoteHtml("https://youtu.be/dQw4w9WgXcQ");
    expect(html).toContain('embedded-service="youtube"');
    expect(html).toContain('data-src="https://youtu.be/dQw4w9WgXcQ"');
  });

  it("leaves unsupported standalone URLs as links", () => {
    const html = markdownToNoteHtml("https://example.com/article");
    expect(html).not.toContain("embedded-service");
    expect(html).toContain("https://example.com/article");
  });

  it("converts stock notation to note money URLs and embeds", () => {
    const html = markdownToNoteHtml("^5243");
    expect(html).toContain('data-src="https://money.note.com/companies/5243"');
    expect(html).toContain('embedded-service="oembed"');
  });
});
