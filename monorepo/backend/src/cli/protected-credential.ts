import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/** Read a recovery credential without following a symlink or reopening the path after validation. */
export function readProtectedCredential(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("credential file must be a regular 0600 file");
    return readFileSync(fd, "utf8").replace(/\r?\n$/, "");
  } finally {
    closeSync(fd);
  }
}
