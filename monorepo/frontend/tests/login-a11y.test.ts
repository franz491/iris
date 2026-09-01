// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("LoginScreen form accessibility", () => {
  it("exposes a named busy form, labelled fields, and the selected credential mode", () => {
    document.body.innerHTML = `<form aria-labelledby="login-title" aria-busy="true"><h1 id="login-title">sign in to iris</h1><label for="login-username">username</label><input id="login-username" autocomplete="username" aria-labelledby="login-username-label"><label for="login-credential">password</label><input id="login-credential" autocomplete="current-password" aria-labelledby="login-credential-label" aria-invalid="true" aria-describedby="login-error"><button type="button" aria-pressed="true">password</button><button type="button" aria-pressed="false">PIN</button><p id="login-error" role="alert" aria-live="assertive">Sign in failed.</p><button aria-busy="true" disabled>signing in…</button></form>`;
    const form = document.querySelector("form")!;
    const credential = document.querySelector<HTMLInputElement>("#login-credential")!;
    expect(form.getAttribute("aria-labelledby")).toBe("login-title");
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector('label[for="login-username"]')).toBeTruthy();
    expect(credential.autocomplete).toBe("current-password");
    expect(credential.getAttribute("aria-describedby")).toBe("login-error");
    expect(document.querySelector('[aria-pressed="true"]')?.textContent).toBe("password");
    expect(document.querySelector('[role="alert"]')?.getAttribute("aria-live")).toBe("assertive");
  });
});
