import { migrationStatusJson } from "../db/migration-status.js";
export function runMigrationCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (s: string) => void = console.log,
): void {
  const [, sub] = argv;
  if (
    (sub !== "status" && sub !== "dry-run") ||
    argv.length !== 2 ||
    !env.IRIS_DATA_DIR ||
    env.IRIS_RECOVERY_CONFIRM !== "CLOSED_HANDLES"
  )
    throw new Error("usage: migration status|dry-run with IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES");
  out(migrationStatusJson(env.IRIS_DATA_DIR));
}
