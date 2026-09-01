import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyRecoveryRetention,
  createSqliteBackup,
  makeRecoveryPairManifest,
  planRecoveryRetention,
  restoreSqliteBackup,
} from "../db/recovery.js";
export async function runRecoveryCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (s: string) => void = console.log,
): Promise<void> {
  const [, sub, tempRoot, source, destination, manifestPath] = argv;
  const dataRoot = env.IRIS_DATA_DIR;
  if (sub === "retention") {
    if (!dataRoot || !tempRoot || argv.length < 3 || argv.length > 5) throw new Error("invalid retention command");
    const minimumKeep = argv[3] === undefined ? 1 : Number(argv[3]);
    const apply = argv[4] === "apply";
    if (argv[4] !== undefined && !apply) throw new Error("retention mode must be apply");
    const roots = { dataRoot, tempRoot };
    const plan = planRecoveryRetention(tempRoot, roots, minimumKeep);
    if (apply && env.IRIS_RECOVERY_CONFIRM !== "RETENTION_DELETE")
      throw new Error("retention apply requires IRIS_RECOVERY_CONFIRM=RETENTION_DELETE");
    const removed = applyRecoveryRetention(plan, roots, !apply);
    out(JSON.stringify({ dryRun: !apply, keep: plan.keep.map((p) => p.manifestPath), remove: removed }));
    return;
  }
  if (
    !dataRoot ||
    !tempRoot ||
    !source ||
    !destination ||
    argv.length !== 6 ||
    env.IRIS_RECOVERY_CONFIRM !== "CLOSED_HANDLES"
  )
    throw new Error("invalid recovery command or confirmation");
  const roots = { dataRoot, tempRoot };
  if (sub === "backup") {
    if (!manifestPath || !safeManifestTarget(tempRoot, manifestPath))
      throw new Error("manifest must be a new regular path within TEMP_ROOT");
    if (existsSync(manifestPath)) throw new Error("manifest already exists");
    const rawManifest = await createSqliteBackup(source, destination, roots);
    const manifest = makeRecoveryPairManifest(destination, roots, rawManifest);
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
      chmodSync(manifestPath, 0o600);
    } catch (error) {
      if (existsSync(manifestPath)) unlinkSync(manifestPath);
      if (existsSync(destination)) unlinkSync(destination);
      throw error;
    }
    out(JSON.stringify(manifest));
  } else if (sub === "restore") {
    if (!manifestPath || !safeManifestExisting(tempRoot, manifestPath))
      throw new Error("manifest must be a regular file within TEMP_ROOT");
    restoreSqliteBackup(source, destination, JSON.parse(readFileSync(manifestPath, "utf8")), roots, true);
    out("restore complete");
  } else throw new Error("invalid recovery command");
}
function safeManifestTarget(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let current = path.resolve(root);
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  }
  return true;
}
function safeManifestExisting(root: string, file: string): boolean {
  return safeManifestTarget(root, file) && lstatSync(file).isFile();
}
