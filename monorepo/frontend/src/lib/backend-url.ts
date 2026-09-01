function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Keep browser loopback traffic on the dev/reverse proxy; Tauri has no proxy. */
export function resolveRequestBase(currentUrl: string, pageProtocol: string, pageHostname: string): string {
  if (!currentUrl && pageProtocol === "tauri:") return "http://127.0.0.1:3000";
  if (!currentUrl) return "";
  try {
    const backend = new URL(currentUrl);
    if (
      (pageProtocol === "http:" || pageProtocol === "https:") &&
      isLoopback(pageHostname) &&
      isLoopback(backend.hostname)
    )
      return "";
  } catch {}
  return currentUrl;
}
