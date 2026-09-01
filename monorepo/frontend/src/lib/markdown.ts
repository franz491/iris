// lib/markdown.ts — safe markdown rendering for AI/user message content.
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

marked.setOptions({ gfm: true, breaks: true });

const linkRenderer = {
  link(
    this: { parser: { parseInline(t: unknown[]): string } },
    { href, title, tokens }: { href: string; title?: string | null; tokens: unknown[] },
  ): string {
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${title}"` : "";
    // Always open in a new tab/browser so the app itself is never replaced.
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};

marked.use({ renderer: linkRenderer as never });

export function markdownToHtml(md: string): string {
  const html = marked.parse(md, { async: false });
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "iframe"],
    ADD_ATTR: ["target", "rel"],
  });
  return clean;
}
