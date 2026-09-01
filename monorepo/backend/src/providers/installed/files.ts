// providers/installed/files.ts
// Provides access to a single folder (files/ by default). File operations run
// on the host inside the sandbox root with symlink-traversal protection; the
// `shell` functionality gives shell access inside a docker container with only
// this folder mounted and no symlink traversal.
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { AppError, NotFoundError, ValidationError } from "../../misc/error.js";
import { runDocker } from "../docker.js";

const json = (s: z.ZodTypeAny): import("../types.js").SchemaObject =>
  zodToJsonSchema(s, { target: "openAi" }) as import("../types.js").SchemaObject;

const createFileSchema = z.object({
  filename: z.string().describe("path relative to the sandbox root"),
  content: z.string().optional().describe("file content; empty file if omitted"),
  encoding: z.enum(["utf8", "base64"]).optional().default("utf8").describe("use base64 for binary files (images, ...)"),
  overwrite: z.boolean().optional().default(true),
});
const readFileSchema = z.object({
  filename: z.string(),
  show_line_numbers: z.boolean().optional().default(false),
  encoding: z.enum(["utf8", "base64"]).optional().default("utf8").describe("use base64 for binary files (images, ...)"),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .optional(),
});
const searchAndReplaceSchema = z.object({
  filename: z.string(),
  pattern: z.string().describe("JS-flavored regex pattern string"),
  substitution: z.string().describe("replacement, supports $1 for capture groups"),
});
const editFileSchema = z.object({
  filename: z.string(),
  before: z.string(),
  after: z.string(),
});
const editLinesSchema = z.object({
  filename: z.string(),
  replace_line_start: z.number().int().positive(),
  replace_line_end: z.number().int().positive(),
  text: z.string().default(""),
});
const shellSchema = z.object({
  command: z.string().describe("shell command to run inside the container"),
});
const okResultSchema = z.object({ ok: z.literal(true) });
const readFileResultSchema = z.object({
  content: z.string().max(14 * 1024 * 1024),
  encoding: z.enum(["utf8", "base64"]),
});

export class FilesProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "files",
    description: "Access to a single sandboxed folder: read/write/edit files and run shell commands in a container.",
    options: [
      {
        name: "create_file",
        description: "Create (or overwrite) a file.",
        kwargsSchema: json(createFileSchema),
        returnSchema: json(okResultSchema),
      },
      {
        name: "read_file",
        description: "Read a file's contents.",
        kwargsSchema: json(readFileSchema),
        returnSchema: json(readFileResultSchema),
      },
      {
        name: "delete_file",
        description: "Delete a file.",
        kwargsSchema: json(z.object({ filename: z.string() })),
        returnSchema: json(okResultSchema),
      },
      {
        name: "search_and_replace",
        description: "Regex search & replace in a file.",
        kwargsSchema: json(searchAndReplaceSchema),
        returnSchema: json(okResultSchema),
      },
      {
        name: "edit_file",
        description: "Replace an exact 'before' block with 'after'.",
        kwargsSchema: json(editFileSchema),
        returnSchema: json(okResultSchema),
      },
      {
        name: "edit_lines",
        description: "Replace a line range with new text.",
        kwargsSchema: json(editLinesSchema),
        returnSchema: json(okResultSchema),
      },
      {
        name: "shell",
        description: "Run a shell command inside the sandbox container.",
        kwargsSchema: json(shellSchema),
        returnSchema: {
          type: "object",
          properties: {
            stdout: { type: "string", maxLength: 14 * 1024 * 1024 },
            stderr: { type: "string", maxLength: 14 * 1024 * 1024 },
          },
          required: ["stdout", "stderr"],
          additionalProperties: false,
        },
      },
    ],
    additionalConfig: {
      type: "object",
      properties: {
        rootFolder: { type: "string", default: "files/", description: "the sandboxed folder" },
        docsFolder: {
          type: "string",
          default: "docs/",
          description: "readonly documentation folder mounted at /sandbox/docs",
        },
        dockerExecutable: { type: "string", default: "docker", description: "docker-compatible CLI to use" },
        dockerImage: { type: "string", default: "alpine:latest", description: "image used for the shell container" },
        timeoutMs: { type: "number", default: 30000 },
      },
    },
  };

  private root!: string;

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.root = path.resolve(this.setting<string>("rootFolder", "files/"));
    await fs.mkdir(this.root, { recursive: true });
    this.emit("reload");
  }

  /** Internal bounded upload primitive; deliberately outside the JSON provider contract. */
  async createFileFromStream(filename: string, source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<void> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ValidationError("invalid upload limit");
    const target = await this.safeResolve(filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.upload-${randomUUID()}`;
    const handle = await fs.open(temporary, "wx", 0o600);
    let total = 0;
    try {
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new ValidationError("upload stream yielded invalid data");
        total += chunk.byteLength;
        if (total > maxBytes) throw new AppError(`file exceeds ${maxBytes} bytes`, "payload_too_large");
        await handle.writeFile(chunk);
      }
      await handle.sync();
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AppError("file already exists", "conflict");
        }
        throw error;
      }
    } finally {
      await handle.close();
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async callStreamFunctionality(
    functionality: string,
    source: AsyncIterable<Uint8Array>,
    kwargs: unknown,
  ): Promise<void> {
    if (functionality !== "create_file_stream") throw new ValidationError("unknown stream functionality");
    const options = z
      .object({
        filename: z.string(),
        max_bytes: z
          .number()
          .int()
          .nonnegative()
          .max(50 * 1024 * 1024),
      })
      .strict()
      .parse(kwargs);
    await this.createFileFromStream(options.filename, source, options.max_bytes);
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppError(`functionality "${functionality}" is not active`, "functionality_inactive");
    }
    switch (functionality) {
      case "create_file": {
        const k = createFileSchema.parse(kwargs);
        if (k.encoding === "utf8" && k.content?.includes("\0")) {
          throw new ValidationError("null byte in utf8 content; use encoding='base64' for binary data");
        }
        const p = await this.safeResolve(k.filename);
        await fs.mkdir(path.dirname(p), { recursive: true });
        const buf = k.encoding === "base64" ? Buffer.from(k.content ?? "", "base64") : (k.content ?? "");
        try {
          await fs.writeFile(p, buf, { flag: k.overwrite ? "w" : "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new AppError("file already exists", "conflict");
          }
          throw error;
        }
        this.emit("create_file", { filename: k.filename });
        return { ok: true };
      }
      case "read_file": {
        const k = readFileSchema.parse(kwargs);
        const p = await this.safeResolve(k.filename);
        if (k.max_bytes !== undefined) {
          const handle = await fs.open(p, "r");
          try {
            const chunks: Buffer[] = [];
            let total = 0;
            while (total <= k.max_bytes) {
              const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, k.max_bytes + 1 - total));
              const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
              if (bytesRead === 0) break;
              total += bytesRead;
              if (total > k.max_bytes) throw new AppError(`file exceeds ${k.max_bytes} bytes`, "payload_too_large");
              chunks.push(chunk.subarray(0, bytesRead));
            }
            const bounded = Buffer.concat(chunks, total);
            if (k.encoding === "base64") return { content: bounded.toString("base64"), encoding: "base64" };
            let content = bounded.toString("utf8");
            if (k.show_line_numbers)
              content = content
                .split("\n")
                .map((l, i) => `${i + 1}: ${l}`)
                .join("\n");
            return { content, encoding: "utf8" };
          } finally {
            await handle.close();
          }
        }
        if (k.encoding === "base64") {
          const buf = await fs.readFile(p);
          return { content: buf.toString("base64"), encoding: "base64" };
        }
        let content = await fs.readFile(p, "utf8");
        if (k.show_line_numbers) {
          content = content
            .split("\n")
            .map((l, i) => `${i + 1}: ${l}`)
            .join("\n");
        }
        return { content, encoding: "utf8" };
      }
      case "delete_file": {
        const k = z.object({ filename: z.string() }).parse(kwargs);
        await fs.unlink(await this.safeResolve(k.filename));
        return { ok: true };
      }
      case "search_and_replace": {
        const k = searchAndReplaceSchema.parse(kwargs);
        const p = await this.safeResolve(k.filename);
        const text = await fs.readFile(p, "utf8");
        const { replaceWithTimeout } = await import("../../misc/regex-worker.js");
        const replaced = await replaceWithTimeout(k.pattern, "gm", text, k.substitution, 5000);
        await fs.writeFile(p, replaced);
        return { ok: true };
      }
      case "edit_file": {
        const k = editFileSchema.parse(kwargs);
        const p = await this.safeResolve(k.filename);
        const text = await fs.readFile(p, "utf8");
        const count = text.split(k.before).length - 1;
        if (count === 0) throw new NotFoundError(`"${k.before}" in ${k.filename}`);
        if (count > 1) {
          throw new ValidationError(
            `"before" block matches ${count} times in ${k.filename}; provide a wider unique block`,
          );
        }
        await fs.writeFile(p, text.replace(k.before, k.after));
        return { ok: true };
      }
      case "edit_lines": {
        const k = editLinesSchema.parse(kwargs);
        if (k.replace_line_end < k.replace_line_start) {
          throw new ValidationError("replace_line_end must be >= replace_line_start");
        }
        const p = await this.safeResolve(k.filename);
        const lines = (await fs.readFile(p, "utf8")).split("\n");
        lines.splice(k.replace_line_start - 1, k.replace_line_end - k.replace_line_start + 1, ...k.text.split("\n"));
        await fs.writeFile(p, lines.join("\n"));
        return { ok: true };
      }
      case "shell":
        return this.shell(shellSchema.parse(kwargs).command);
      default:
        throw new AppError(`unknown functionality "${functionality}"`, "unknown_functionality");
    }
  }

  /** Run a command inside a docker container mounting only the sandbox root. */
  private async shell(command: string): Promise<{ stdout: string; stderr: string }> {
    const exe = this.setting<string>("dockerExecutable", "docker");
    const image = this.setting<string>("dockerImage", "alpine:latest");
    const timeoutMs = this.setting<number>("timeoutMs", 30_000);
    // mount root read-only at /sandbox? No: writable workdir /sandbox.
    const docs = path.resolve(this.setting<string>("docsFolder", "docs/"));
    const res = await runDocker(
      exe,
      [
        "run",
        "--rm",
        "-v",
        `${this.root}:/sandbox`,
        "-v",
        `${docs}:/sandbox/docs:ro`,
        "-w",
        "/sandbox",
        image,
        "sh",
        "-c",
        command,
      ],
      { timeoutMs },
    );
    if (res.code !== 0 && !res.stdout) {
      throw new AppError(res.stderr.trim() || `shell exited with code ${res.code}`, "shell_error");
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }

  /**
   * Resolve a user-supplied relative path inside the sandbox root,
   * rejecting absolute paths, "..", and symlink traversal.
   */
  private async safeResolve(filename: string): Promise<string> {
    if (path.isAbsolute(filename)) throw new ValidationError(`absolute paths not allowed: ${filename}`);
    const resolved = path.resolve(this.root, filename);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new ValidationError(`path escapes sandbox: ${filename}`);
    }
    // symlink traversal guard: every component up to the file must not be a symlink
    let cur = this.root;
    const rel = path.relative(this.root, resolved);
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      try {
        const st = await fs.lstat(cur);
        if (st.isSymbolicLink()) throw new ValidationError(`symlink traversal disallowed: ${filename}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") break; // will be created / or missing target
        throw e;
      }
    }
    return resolved;
  }
}
