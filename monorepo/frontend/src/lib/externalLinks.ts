// lib/externalLinks.ts — inside Tauri, ALL links open in the user's system
// browser instead of navigating/replacing the app webview.
//
// Mechanism: capture-phase document click listener intercepts every anchor
// click (covers both static <a> elements and {@html}-rendered markdown
// links). A link is "external" when its resolved origin differs from the
// app's own origin — the app always talks to the backend same-origin (/api),
// so same-origin links (file downloads, images, in-app routes) stay in the
// webview while everything else opens in the OS browser via the
// tauri-plugin-shell `open` command (already registered in src-tauri;
// enabled by plugins.shell.open).
// Outside Tauri this module is a no-op — normal browser behavior applies,
// which is why markdown links also get target="_blank" at render time.
import { invoke } from "@tauri-apps/api/core";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function installExternalLinkHandler(): void {
  if (!inTauri()) return;

  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;

      const raw = anchor.getAttribute("href") ?? "";
      let url: URL;
      try {
        url = new URL(raw, location.href);
      } catch {
        return;
      }
      // Same-origin (backend files, in-app routes) stays inside the webview;
      // anything else opens in the system browser.
      if (url.origin === location.origin) return;
      if (url.protocol !== "http:" && url.protocol !== "https:") return;

      e.preventDefault();
      e.stopPropagation();
      void invoke("plugin:shell|open", { path: url.href }).catch((err) => {
        console.error("failed to open external browser:", err);
        window.open(url.href, "_blank", "noopener");
      });
    },
    true,
  );
}
