import { originMatches } from "../setup/settings.js";

export type MutationOriginDecision = "allowed" | "untrusted_origin" | "csrf_origin_required";

/** Cookie-authenticated mutations require an explicit configured origin. */
export function mutationOriginDecision(
  origin: string | undefined,
  hasCookie: boolean,
  trustedOrigins: readonly string[],
): MutationOriginDecision {
  if (origin && !originMatches(origin, [...trustedOrigins])) return "untrusted_origin";
  if (!origin && hasCookie) return "csrf_origin_required";
  return "allowed";
}
