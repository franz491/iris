// Authentication and authorization guards shared by API route modules.
// Keep this module independent of api.ts so leaf routes cannot depend on the
// aggregate router (and accidentally create an import cycle).
import { auth, hasRecentAuthGrant, isAdminUser } from "./auth.js";
import { isUserAuthorizedInChat, GUEST_USER_ID } from "../chat/auth.js";
import { UnauthorizedError } from "../misc/error.js";

export async function resolveViewer(req: Request): Promise<{ userId: string; isGuest: boolean }> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!session?.user?.id) return { userId: GUEST_USER_ID, isGuest: true };
  return { userId: session.user.id, isGuest: false };
}

export async function requireAuthenticatedUser(req: Request): Promise<{ userId: string }> {
  const { userId, isGuest } = await resolveViewer(req);
  if (isGuest) throw new UnauthorizedError();
  return { userId };
}

/** Resolve a guest or registered viewer and require membership in a chat. */
export async function requireChatMember(req: Request, chatId: string): Promise<{ userId: string; isGuest: boolean }> {
  const viewer = await resolveViewer(req);
  if (!(await isUserAuthorizedInChat(chatId, viewer.userId))) {
    throw new UnauthorizedError("not in this chat");
  }
  return viewer;
}

/** Require an authenticated account that currently holds the administrator role. */
export async function requireAdmin(req: Request): Promise<{ userId: string }> {
  const viewer = await requireAuthenticatedUser(req);
  if (!isAdminUser(viewer.userId)) throw new UnauthorizedError("administrator required");
  return viewer;
}

/** Require a server-observed, five-minute step-up authentication. */
export async function requireRecentAuth(req: Request): Promise<{ userId: string }> {
  const adminUser = await requireAdmin(req);
  const current = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  const session = current?.session;
  if (!session || session.userId !== adminUser.userId) throw new UnauthorizedError("recent authentication required");
  const createdAt = session.createdAt instanceof Date ? session.createdAt.getTime() : Number(session.createdAt);
  if (Number.isFinite(createdAt) && Date.now() - createdAt < 5 * 60 * 1000) return adminUser;
  if (hasRecentAuthGrant(session.id, adminUser.userId)) return adminUser;
  throw new UnauthorizedError("recent authentication required");
}
