// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../src/lib/markdown";

describe("markdownToHtml", () => {
  it("renders basic markdown", () => {
    const html = markdownToHtml("# Title\n\n**bold** and `code`");
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("strips scripts and event handlers (XSS)", () => {
    const html = markdownToHtml('hello <script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("keeps safe links", () => {
    const html = markdownToHtml("[click](https://example.com)");
    expect(html).toContain('href="https://example.com"');
  });
});
