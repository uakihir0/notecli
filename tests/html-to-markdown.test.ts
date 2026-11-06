import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "../src/lib/html-to-markdown.js";

describe("htmlToMarkdown", () => {
  it("returns an empty string for empty HTML", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("converts headings, paragraphs, lists, and links", () => {
    const markdown = htmlToMarkdown(
      '<h2 name="x" id="x">Title</h2><p name="y" id="y">Hello <strong>world</strong> and <a href="https://example.com">link</a>.</p><ul><li><p>One</p></li><li><p>Two</p></li></ul>'
    );
    expect(markdown).toContain("## Title");
    expect(markdown).toContain("Hello **world** and [link](https://example.com).");
    expect(markdown).toContain("- One");
    expect(markdown).toContain("- Two");
  });

  it("converts note.com image figures to Markdown images", () => {
    const markdown = htmlToMarkdown(
      '<figure name="x" id="x"><img src="https://example.com/a.png" alt="Alt" width="620" height="457"><figcaption>Caption</figcaption></figure>'
    );
    expect(markdown).toContain('![Alt](https://example.com/a.png "Caption")');
  });

  it("converts blockquote figures with citations", () => {
    const markdown = htmlToMarkdown(
      '<figure name="x" id="x"><blockquote><p name="p" id="p">Knowledge is power</p></blockquote><figcaption>Francis Bacon</figcaption></figure>'
    );
    expect(markdown).toContain("> Knowledge is power");
    expect(markdown).toContain("> — Francis Bacon");
  });

  it("converts table-of-contents elements to [TOC]", () => {
    const markdown = htmlToMarkdown(
      '<table-of-contents name="x" id="x"></table-of-contents><h2 name="y" id="y">Section</h2>'
    );
    expect(markdown).toContain("[TOC]");
    expect(markdown).toContain("## Section");
  });

  it("converts embed figures back to standalone URLs", () => {
    const markdown = htmlToMarkdown(
      '<figure name="x" id="x" data-src="https://youtu.be/dQw4w9WgXcQ" embedded-service="youtube" embedded-content-key="emb1"></figure>'
    );
    expect(markdown.trim()).toBe("https://youtu.be/dQw4w9WgXcQ");
  });

  it("converts code blocks to fenced Markdown", () => {
    const markdown = htmlToMarkdown(
      '<pre name="x" id="x" class="codeBlock"><code>const x = 1;\nconsole.log(x);\n</code></pre>'
    );
    expect(markdown).toContain("```\nconst x = 1;");
    expect(markdown).toContain("console.log(x);");
  });
});
