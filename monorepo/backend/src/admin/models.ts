import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { z } from "zod";
import { openDb, dataFile } from "../db/sqlite.js";

export const db = openDb(dataFile("admin.db")).sqlite;
export function migrateModelsDb(injectFailure = false, connection = db): void {
  connection.transaction(() => {
    connection.exec(
      "CREATE TABLE IF NOT EXISTS admin_models (id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,ownership TEXT NOT NULL,size_bytes INTEGER,format TEXT,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_models_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    if (injectFailure) throw new Error("injected models migration failure");
    connection.prepare("INSERT OR IGNORE INTO admin_models_schema_migrations VALUES (1, ?)").run(Date.now());
  })();
}
migrateModelsDb();

export interface RegisteredModel {
  id: string;
  name: string;
  path: string;
  ownership: "external" | "managed";
  sizeBytes: number | null;
  format: string | null;
  createdAt: string;
}

const modelRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    ownership: z.enum(["external", "managed"]),
    size_bytes: z.number().int().nullable(),
    format: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
type ModelRow = z.infer<typeof modelRowSchema>;
const modelOwnershipRowSchema = modelRowSchema.pick({ ownership: true });

export function registerModel(input: {
  name: string;
  path: string;
  ownership?: "external" | "managed";
}): RegisteredModel {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(input.path).size;
  } catch {}

  const row = {
    id: randomUUID(),
    name: input.name,
    path: input.path,
    ownership: input.ownership ?? "external",
    sizeBytes,
    format: input.path.split(".").pop() ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO admin_models VALUES (?,?,?,?,?,?,?)").run(
    row.id,
    row.name,
    row.path,
    row.ownership,
    row.sizeBytes,
    row.format,
    row.createdAt,
  );
  return row;
}

function toRegisteredModel(row: ModelRow): RegisteredModel {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    ownership: row.ownership,
    sizeBytes: row.size_bytes,
    format: row.format,
    createdAt: row.created_at,
  };
}

export function listModels(): RegisteredModel[] {
  return db
    .prepare("SELECT * FROM admin_models ORDER BY name")
    .all()
    .map((row) => toRegisteredModel(modelRowSchema.parse(row)));
}

export function removeModel(id: string): boolean {
  const parsed = modelOwnershipRowSchema.safeParse(db.prepare("SELECT ownership FROM admin_models WHERE id=?").get(id));
  if (!parsed.success || parsed.data.ownership !== "managed") return false;
  return db.prepare("DELETE FROM admin_models WHERE id=?").run(id).changes > 0;
}
