import { lstatSync, readFileSync } from "node:fs";
import { findUsersByIdentifier, isAdminUser, adminCount, resetUserCredential } from "../api/auth.js";
import { auditUserMutation } from "../admin/store.js";

export interface LostAdminDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
  readStdin?: () => string;
  findUsers?: typeof findUsersByIdentifier;
  isAdmin?: typeof isAdminUser;
  countAdmins?: typeof adminCount;
  reset?: typeof resetUserCredential;
  audit?: typeof auditUserMutation;
  out?: (message: string) => void;
  fail?: (message: string) => never;
}
export async function handleLostAdminRecovery(args: string[], deps: LostAdminDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const fail =
    deps.fail ??
    ((message: string): never => {
      throw new Error(message);
    });
  const [identifier, ...rest] = args;
  const actor = env.IRIS_RECOVERY_ACTOR?.trim();
  if (env.IRIS_RECOVERY_CONFIRM !== "LOST_ADMIN_RECOVERY")
    fail("lost-admin requires IRIS_RECOVERY_CONFIRM=LOST_ADMIN_RECOVERY");
  if (!identifier || !actor) fail("usage: recovery lost-admin <username-or-email> --credential-file <path>");
  const find = deps.findUsers ?? findUsersByIdentifier;
  const isAdmin = deps.isAdmin ?? isAdminUser;
  if (!isAdmin(actor!)) fail("recovery actor must be an administrator");
  if ((deps.countAdmins ?? adminCount)() < 1) fail("recovery refused: no administrator exists");
  const matches = find(identifier);
  if (matches.length !== 1) fail(matches.length ? "ambiguous account identifier" : "no such user");
  const fileIndex = rest.findIndex((arg) => arg === "--credential-file" || arg === "-f");
  let credential = "";
  if (fileIndex >= 0) {
    const file = rest[fileIndex + 1];
    if (!file || rest.length !== fileIndex + 2)
      fail("usage: recovery lost-admin <username-or-email> --credential-file <path>");
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0)
      fail("credential file must be a regular 0600 file");
    credential = (deps.readFile ?? ((p) => readFileSync(p, "utf8")))(file).replace(/\r?\n$/, "");
  } else if (rest.length === 1 && rest[0] === "--stdin")
    credential = (deps.readStdin ?? (() => readFileSync(0, "utf8")))().replace(/\r?\n$/, "");
  else if (env.NODE_ENV === "test" && rest.length === 1 && rest[0] === "--env-test")
    credential = env.IRIS_TEST_RECOVERY_CREDENTIAL ?? "";
  else fail("new credential must come from a protected 0600 file or stdin");
  await (deps.reset ?? resetUserCredential)(matches[0].id, credential);
  (deps.audit ?? auditUserMutation)(actor!, matches[0].id, "lost_admin_recovery");
  (deps.out ?? console.log)(`lost-admin recovery completed for ${matches[0].email}; all sessions revoked`);
}
