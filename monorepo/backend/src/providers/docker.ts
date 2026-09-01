// providers/docker.ts — thin wrapper around a docker-compatible CLI.
// The executable name is configurable (docker / podman / etc.) so users can
// swap alternatives.
import { spawn } from "node:child_process";

export interface DockerRunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `<exe> <args...>` and capture output. */
export function runDocker(exe: string, args: string[], opts: DockerRunOptions = {}): Promise<DockerRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`docker command timed out after ${opts.timeoutMs}ms: ${exe} ${args.join(" ")}`));
          }
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}
