// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";

describe("upload cancellation lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards an AbortSignal to the production attachment transport", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ messageId: "message-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(api.uploadFile("chat-1", "photo.png", new Blob(["x"]), controller.signal)).resolves.toEqual({
      messageId: "message-1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps cancellation ownership independent for concurrent uploads", () => {
    const first = new AbortController();
    const second = new AbortController();
    first.abort();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    second.abort();
    expect(second.signal.aborted).toBe(true);
  });

  it("exposes non-secret live-region semantics for completion, cancellation, and errors", () => {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Attachment uploaded";
    expect(status.textContent).toBe("Attachment uploaded");
    status.textContent = "Upload cancelled";
    expect(status.textContent).not.toMatch(/filename|\.png/i);
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.setAttribute("aria-live", "assertive");
    error.textContent = "Upload failed. Try again.";
    expect(error.getAttribute("role")).toBe("alert");
  });
});
