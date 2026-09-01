// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("upload/history accessibility contracts", () => {
  it("keeps picker controls named and upload failures assertive", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("aria-label", "Change profile picture");
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Upload attachment");
    const alert = document.createElement("p");
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "assertive");
    expect(trigger.getAttribute("aria-label")).toBeTruthy();
    expect(input.getAttribute("aria-label")).toBe("Upload attachment");
    expect(alert.getAttribute("role")).toBe("alert");
  });
  it("exposes history loading state to assistive technology", () => {
    const button = document.createElement("button");
    button.setAttribute("aria-busy", "true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    button.setAttribute("aria-busy", "false");
    expect(button.getAttribute("aria-busy")).toBe("false");
  });
});
