export type ApprovalKind = "standard" | "network" | "download";
export function classifyPatch(patch: unknown, baseline?: unknown): { required: ApprovalKind[]; reasons: string[] } {
  const patchRecord = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const baselineRecord = baseline && typeof baseline === "object" ? (baseline as Record<string, unknown>) : {};
  const changed = (key: string) => JSON.stringify(patchRecord[key]) !== JSON.stringify(baselineRecord[key]);
  const required = new Set<ApprovalKind>(["standard"]);
  const reasons: string[] = [];
  if (changed("server")) {
    required.add("network");
    reasons.push("network or TLS settings changed");
  }
  if (/download|managed|install/i.test(JSON.stringify(patchRecord))) {
    required.add("download");
    reasons.push("software or managed asset operation detected");
  }
  return { required: [...required], reasons };
}
