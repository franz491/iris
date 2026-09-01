import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";
import { dataFile } from "../db/sqlite.js";

const MAX_METADATA_BYTES = 1024 * 1024;
type JsonShape = "object" | "array";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string, shape: JsonShape): unknown {
  if (!existsSync(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.allocUnsafe(MAX_METADATA_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_METADATA_BYTES) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    const parsed: unknown = JSON.parse(text);
    if (shape === "object" ? !isRecord(parsed) : !Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Static audio.cpp metadata shipped with Iris, suitable for dynamic admin UIs. */
export function audioFamilyMetadata(family?: string): unknown {
  const root = dataFile("software/audio.cpp");
  if (family) return readJson(`${root}/model_specs/${family}.json`, "object") ?? { family, status: "unknown" };
  const params = readJson(`${root}/webui/configs/model_params.json`, "object");
  const catalog = readJson(`${root}/webui/configs/models_catalog.json`, "array");
  return { families: params ?? {}, models: catalog ?? [] };
}
