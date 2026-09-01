// providers/installed/shell.ts
// Shell access for the AI into a docker container with a single folder
// mounted, no symlinks.
import { spawn } from "node:child_process";
import path from "node:path";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { AppError, ValidationError } from "../../misc/error.js";
import { runDocker } from "../docker.js";

const json = (s: z.ZodTypeAny): import("../types.js").SchemaObject =>
  zodToJsonSchema(s, { target: "openAi" }) as import("../types.js").SchemaObject;

const oneshotSchema = z.object({
  command: z.string().describe("command to run; the shell closes afterwards"),
});
const interactiveSchema = z.object({
  command: z.string().optional().describe("initial command; the shell stays open"),
});
const oneshotResultSchema = z.object({
  code: z.number().int(),
  stdout: z.string().max(14 * 1024 * 1024),
  stderr: z.string().max(14 * 1024 * 1024),
  cwd: z.literal("/sandbox"),
});

export interface ShellStreams {
  stdin: NodeJS.WritableStream;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  close(): void;
}

interface InteractiveSession {
  id: string;
  streams: ShellStreams;
}

export class ShellProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "shell",
    description: "Shell access inside a sandboxed docker container with one mounted folder.",
    options: [
      {
        name: "shell_oneshot",
        description: "Send a command, receive output, shell closes.",
        kwargsSchema: json(oneshotSchema),
        returnSchema: json(oneshotResultSchema),
      },
      {
        name: "shell_interactive",
        description: "Open a persistent shell session.",
        kwargsSchema: json(interactiveSchema),
        returnSchema: {
          type: "object",
          properties: { kind: { const: "interactive_session" }, version: { const: 1 }, sessionId: { type: "string" } },
          required: ["kind", "version", "sessionId"],
          additionalProperties: false,
        },
      },
    ],
    additionalConfig: {
      type: "object",
      properties: {
        rootFolder: { type: "string", default: "shell/", description: "the shell folder" },
        docsFolder: {
          type: "string",
          default: "docs/",
          description: "readonly documentation folder mounted at /sandbox/docs",
        },
        dockerExecutable: { type: "string", default: "docker" },
        dockerImage: { type: "string", default: "alpine:latest" },
        timeoutMs: { type: "number", default: 30000 },
      },
    },
  };

  private root!: string;
  private sessions = new Map<string, InteractiveSession>();
  private nextId = 1;

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.root = path.resolve(this.setting<string>("rootFolder", "shell/"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.root, { recursive: true });
    // "no symlinks" is enforced by mount isolation alone: only this folder is
    // mounted, so links pointing outside resolve to nothing inside the
    // container. No stripping needed.
    this.emit("reload");
  }

  private dockerArgs(cmd: string[]): string[] {
    const exeArgs = [
      "run",
      "--rm",
      "-v",
      `${this.root}:/sandbox`,
      "-v",
      `${path.resolve(this.setting<string>("docsFolder", "docs/"))}:/sandbox/docs:ro`,
      "-w",
      "/sandbox",
      this.setting<string>("dockerImage", "alpine:latest"),
      ...cmd,
    ];
    return exeArgs;
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppError(`functionality "${functionality}" is not active`, "functionality_inactive");
    }
    switch (functionality) {
      case "shell_oneshot": {
        const k = oneshotSchema.parse(kwargs);
        const res = await runDocker(
          this.setting<string>("dockerExecutable", "docker"),
          this.dockerArgs(["sh", "-c", k.command]),
          {
            timeoutMs: this.setting<number>("timeoutMs", 30_000),
          },
        );
        return { code: res.code, stdout: res.stdout, stderr: res.stderr, cwd: "/sandbox" };
      }
      case "shell_interactive": {
        const k = interactiveSchema.parse(kwargs);
        const exe = this.setting<string>("dockerExecutable", "docker");
        const child = spawn(exe, [...this.dockerArgs([]), "-i", "sh"], { stdio: ["pipe", "pipe", "pipe"] });
        const id = `session-${this.nextId++}`;
        const session: InteractiveSession = {
          id,
          streams: {
            stdin: child.stdin,
            stdout: nodeStreamToAsync(child.stdout),
            stderr: nodeStreamToAsync(child.stderr),
            close: () => child.kill(),
          },
        };
        this.sessions.set(id, session);
        child.on("close", () => this.sessions.delete(id));
        if (k.command) child.stdin.write(k.command + "\n");
        return { kind: "interactive_session", version: 1, sessionId: id };
      }
      case "__get_session": {
        // internal helper used by higher layers to reach an open session
        const { sessionId } = kwargs as { sessionId: string };
        const s = this.sessions.get(sessionId);
        if (!s) throw new ValidationError(`no such session: ${sessionId}`);
        return s.streams;
      }
      default:
        throw new AppError(`unknown functionality "${functionality}"`, "unknown_functionality");
    }
  }
}

/** Chunked async iterator over a readable stream. */
function nodeStreamToAsync(readable: NodeJS.ReadableStream): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<string>>((resolve, reject) => {
            const onData = (chunk: Buffer | string) => {
              cleanup();
              resolve({ done: false, value: String(chunk) });
            };
            const onEnd = () => {
              cleanup();
              resolve({ done: true, value: undefined as never });
            };
            const onError = (err: Error) => {
              cleanup();
              reject(err);
            };
            const cleanup = () => {
              readable.off("data", onData);
              readable.off("end", onEnd);
              readable.off("error", onError);
            };
            readable.once("end", onEnd);
            readable.once("error", onError);
            readable.on("data", onData);
          }),
      };
    },
  };
}
