/** Offline, bounded SQLite backup and restore primitive (IRIS-062).
 * This module deliberately has no HTTP surface and never overwrites a target.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  unlinkSync,
  linkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

export interface RecoveryRoots {
  dataRoot: string;
  tempRoot: string;
}
export interface BackupManifest {
  version: 1;
  sha256: string;
  bytes: number;
  createdAt: string;
}
export interface RecoveryPairManifest {
  format: "iris-recovery-pair";
  version: 1;
  backupPath: string;
  manifest: BackupManifest;
}
export interface DiscoveredRecoveryPair {
  manifestPath: string;
  backupPath: string;
  manifest: RecoveryPairManifest;
}
export interface RecoveryRetentionPlan {
  keep: DiscoveredRecoveryPair[];
  remove: DiscoveredRecoveryPair[];
}
/** Injectable boundary for filesystem promotion; production uses node:fs. */
export interface RecoveryFilesystem {
  exists(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  chmod(path: string, mode: number): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  write(path: string, data: Uint8Array, options: { flag: string; mode: number }): void;
}
const productionFilesystem: RecoveryFilesystem = {
  exists: existsSync,
  mkdir: (p, o) => mkdirSync(p, o),
  chmod: (p, m) => chmodSync(p, m),
  link: (a, b) => linkSync(a, b),
  unlink: (p) => unlinkSync(p),
  write: (p, d, o) => writeFileSync(p, d, o),
};

/** Build a deterministic, non-mutating retention plan. Invalid/tampered pairs
 * are never deletion candidates. The newest valid pair(s) are retained. */
export function planRecoveryRetention(tempRoot: string, roots: RecoveryRoots, minimumKeep = 1): RecoveryRetentionPlan {
  if (!Number.isSafeInteger(minimumKeep) || minimumKeep < 1) throw new Error("minimumKeep must be a positive integer");
  const valid = discoverRecoveryPairs(tempRoot, roots)
    .map((pair) => revalidateRecoveryPair(pair, roots))
    .sort(
      (a, b) =>
        b.manifest.manifest.createdAt.localeCompare(a.manifest.manifest.createdAt) ||
        a.manifestPath.localeCompare(b.manifestPath),
    );
  // A backup may have multiple wrapper manifests; retain one wrapper and its
  // owned backup, rather than planning deletion of a shared backup.
  const unique: DiscoveredRecoveryPair[] = [];
  const seen = new Set<string>();
  for (const pair of valid)
    if (!seen.has(pair.backupPath)) {
      seen.add(pair.backupPath);
      unique.push(pair);
    }
  return { keep: unique.slice(0, minimumKeep), remove: unique.slice(minimumKeep) };
}

/** Apply only an already-created plan. Revalidation is all-or-nothing. */
export function applyRecoveryRetention(plan: RecoveryRetentionPlan, roots: RecoveryRoots, dryRun = true): string[] {
  const all = [...plan.keep, ...plan.remove];
  const checked = all.map((pair) => revalidateRecoveryPair(pair, roots));
  if (dryRun) return checked.flatMap((pair) => [pair.manifestPath, pair.backupPath]);
  // Validate every target before the first mutation; failures therefore fail closed.
  const remove = new Set(plan.remove.map((pair) => `${pair.manifestPath}\0${pair.backupPath}`));
  const targets = checked.filter((pair) => remove.has(`${pair.manifestPath}\0${pair.backupPath}`));
  for (const pair of targets) {
    unlinkSync(pair.manifestPath);
    unlinkSync(pair.backupPath);
  }
  return targets.flatMap((pair) => [pair.manifestPath, pair.backupPath]);
}
export function revalidateRecoveryPair(pair: DiscoveredRecoveryPair, roots: RecoveryRoots): DiscoveredRecoveryPair {
  const manifest = inside(roots.tempRoot, pair.manifestPath),
    backup = inside(roots.dataRoot, pair.backupPath);
  if (
    manifest !== pair.manifestPath ||
    backup !== pair.backupPath ||
    lstatSync(manifest).isSymbolicLink() ||
    lstatSync(backup).isSymbolicLink()
  )
    throw new Error("recovery pair changed");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  if (!isPairManifest(parsed) || parsed.backupPath !== pair.manifest.backupPath)
    throw new Error("recovery pair mismatch");
  validatePairManifest(parsed, backup, roots.dataRoot);
  const actual = digest(backup);
  if (actual.sha256 !== parsed.manifest.sha256 || actual.bytes !== parsed.manifest.bytes)
    throw new Error("recovery pair digest mismatch");
  return { manifestPath: manifest, backupPath: backup, manifest: parsed };
}
export type RecoveryManifest = BackupManifest | RecoveryPairManifest;

function inside(root: string, file: string): string {
  const r = path.resolve(root),
    f = path.resolve(file),
    rel = path.relative(r, f);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path must be within its supplied root");
  let current = r;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("path components must not be symbolic links");
  }
  return f;
}
function regular(file: string): void {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("symbolic links are not allowed");
}
function digest(file: string): { sha256: string; bytes: number } {
  const fd = openSync(file, "r");
  try {
    const h = createHash("sha256");
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n = 0,
      read;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, read));
      n += read;
    }
    return { sha256: h.digest("hex"), bytes: n };
  } finally {
    closeSync(fd);
  }
}
function check(file: string): void {
  const db = new Database(file, { readonly: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SQLite integrity_check failed");
  } finally {
    db.close();
  }
}

export async function createSqliteBackup(
  sourcePath: string,
  destinationPath: string,
  roots: RecoveryRoots,
  filesystem: RecoveryFilesystem = productionFilesystem,
): Promise<BackupManifest> {
  const source = inside(roots.dataRoot, sourcePath),
    destination = inside(roots.dataRoot, destinationPath);
  regular(source);
  regular(destination);
  if (!existsSync(source)) throw new Error("source database does not exist");
  filesystem.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  filesystem.mkdir(roots.tempRoot, { recursive: true, mode: 0o700 });
  // Stage beside the destination so promotion is one-filesystem and atomic.
  const staging = path.join(
    path.dirname(destination),
    `.iris-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  try {
    const db = new Database(source, { readonly: true });
    try {
      await db.backup(staging);
    } finally {
      db.close();
    }
    filesystem.chmod(staging, 0o600);
    check(staging);
    const info = digest(staging),
      manifest: BackupManifest = { version: 1, ...info, createdAt: new Date().toISOString() };
    // link() is atomic and fails with EEXIST, so a concurrent/existing target is preserved.
    filesystem.link(staging, destination);
    filesystem.unlink(staging);
    return manifest;
  } catch (e) {
    if (filesystem.exists(staging)) filesystem.unlink(staging);
    throw e;
  }
}

export function restoreSqliteBackup(
  backupPath: string,
  destinationPath: string,
  manifest: RecoveryManifest,
  roots: RecoveryRoots,
  handlesClosed: boolean,
  filesystem: RecoveryFilesystem = productionFilesystem,
): void {
  if (!handlesClosed) throw new Error("database handles must be closed before restore");
  const backup = resolveRecoveryInput(backupPath, roots);
  const destination = inside(roots.dataRoot, destinationPath);
  const raw = isPairManifest(manifest) ? validatePairManifest(manifest, backup, roots.dataRoot) : manifest;
  regular(backup);
  regular(destination);
  if (!existsSync(backup)) throw new Error("backup does not exist");
  const actual = digest(backup);
  if (!isRawManifest(raw) || actual.sha256 !== raw.sha256 || actual.bytes !== raw.bytes)
    throw new Error("backup manifest mismatch");
  check(backup);
  const staging = path.join(
    path.dirname(destination),
    `.iris-restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  try {
    const src = readFileSync(backup);
    filesystem.write(staging, src, { mode: 0o600, flag: "wx" });
    check(staging);
    filesystem.link(staging, destination);
    filesystem.unlink(staging);
    // The staged file is created owner-only and promoted by hard-link.  Do not
    // chmod the live destination after promotion: a permission failure there
    // would report restore failure after the database had already become live.
  } catch (e) {
    if (filesystem.exists(staging)) filesystem.unlink(staging);
    throw e;
  }
}

/** Resolve an input accepted from the offline CLI while checking every
 * existing parent component. A prefix check alone permits a symlinked
 * directory inside a trusted root to redirect reads outside that root. */
function resolveRecoveryInput(file: string, roots: RecoveryRoots): string {
  const candidate = path.resolve(file);
  for (const root of [roots.tempRoot, roots.dataRoot]) {
    try {
      return inside(root, candidate);
    } catch {
      // Try the other explicitly supplied root.
    }
  }
  throw new Error("backup must be within supplied roots and contain no symlinked components");
}

function isRawManifest(value: unknown): value is BackupManifest {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as BackupManifest).version === 1 &&
    typeof (value as BackupManifest).sha256 === "string" &&
    Number.isInteger((value as BackupManifest).bytes) &&
    typeof (value as BackupManifest).createdAt === "string",
  );
}
function isPairManifest(value: unknown): value is RecoveryPairManifest {
  return Boolean(value && typeof value === "object" && (value as RecoveryPairManifest).format === "iris-recovery-pair");
}
function validatePairManifest(pair: RecoveryPairManifest, backup: string, dataRoot: string): BackupManifest {
  if (pair.version !== 1 || typeof pair.backupPath !== "string" || !isRawManifest(pair.manifest))
    throw new Error("malformed recovery pair manifest");
  const expected = inside(dataRoot, path.resolve(dataRoot, pair.backupPath));
  if (expected !== backup) throw new Error("recovery pair backup path mismatch");
  return pair.manifest;
}

export function makeRecoveryPairManifest(
  backupPath: string,
  roots: RecoveryRoots,
  manifest: BackupManifest,
): RecoveryPairManifest {
  const backup = inside(roots.dataRoot, backupPath);
  if (!isRawManifest(manifest)) throw new Error("invalid backup manifest");
  return {
    format: "iris-recovery-pair",
    version: 1,
    backupPath: path.relative(path.resolve(roots.dataRoot), backup),
    manifest,
  };
}

/** Non-mutating scan for validated wrapper manifests and their owned backups. */
export function discoverRecoveryPairs(tempRoot: string, roots: RecoveryRoots): DiscoveredRecoveryPair[] {
  const root = inside(path.dirname(path.resolve(tempRoot)), tempRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  const result: DiscoveredRecoveryPair[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) {
        if (!stat.isSymbolicLink()) visit(file);
        continue;
      }
      if (!/\.json$/i.test(name) || !stat.isFile()) continue;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (!isPairManifest(parsed)) continue;
        const backup = path.resolve(roots.dataRoot, parsed.backupPath);
        if (!inside(roots.dataRoot, backup) || lstatSync(backup).isSymbolicLink()) continue;
        validatePairManifest(parsed, backup, roots.dataRoot);
        const actual = digest(backup);
        if (actual.sha256 !== parsed.manifest.sha256 || actual.bytes !== parsed.manifest.bytes) continue;
        result.push({ manifestPath: file, backupPath: backup, manifest: parsed });
      } catch {
        /* unrelated or malformed candidates are ignored */
      }
    }
  };
  visit(root);
  return result;
}
