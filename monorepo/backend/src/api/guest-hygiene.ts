export interface GuestHygieneDeps {
  getAppMeta: (key: string) => Promise<string | null>;
  readKeep: () => number;
  pruneMessages: (chatId: string, keep: number) => Promise<void>;
}

/** Best-effort guest history maintenance; it never affects message delivery. */
export async function performGuestHygiene(chatId: string, deps: GuestHygieneDeps): Promise<void> {
  try {
    if ((await deps.getAppMeta("guest_chat_id")) !== chatId) return;
    const keep = deps.readKeep();
    if (keep > 0) await deps.pruneMessages(chatId, keep);
  } catch {
    // Hygiene is deliberately contained: a message request must not fail or wait on it.
  }
}

/** Schedule maintenance without adding it to the request's critical path. */
export function scheduleGuestHygiene(chatId: string, deps: GuestHygieneDeps): void {
  void performGuestHygiene(chatId, deps);
}
