import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every backend test process starts outside the repository data directory.
 * Individual tests may replace this with a more focused temporary directory.
 */
process.env.IRIS_DATA_DIR = mkdtempSync(join(tmpdir(), "iris-vitest-"));
