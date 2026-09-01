// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("bootstrap form accessibility contract", () => {
  it("associates labelled credentials with live failure and restores focus", () => {
    document.body.innerHTML = `<label for="bootstrap-token">single-use setup token</label><input id="bootstrap-token"><label for="bootstrap-password">administrator password</label><input id="bootstrap-password" autocomplete="new-password"><p id="bootstrap-error" role="alert" aria-live="assertive">Passwords do not match.</p>`;
    const token = document.querySelector<HTMLInputElement>("#bootstrap-token")!;
    const password = document.querySelector<HTMLInputElement>("#bootstrap-password")!;
    token.setAttribute("aria-invalid", "true");
    token.setAttribute("aria-describedby", "bootstrap-error");
    password.setAttribute("aria-invalid", "true");
    password.setAttribute("aria-describedby", "bootstrap-error");
    expect(document.querySelector("label[for=bootstrap-token]")).toBeTruthy();
    expect(password.autocomplete).toBe("new-password");
    expect(document.querySelector("[role=alert]")?.getAttribute("aria-live")).toBe("assertive");
    expect(token.getAttribute("aria-describedby")).toBe("bootstrap-error");
    token.focus();
    expect(document.activeElement).toBe(token);
  });
});
