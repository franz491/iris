import { randomUUID } from "node:crypto";
interface Handle {
  chatId: string;
  ownerId: string;
  bytes: Buffer;
  mimeType: string;
  createdAt: number;
}
const handles = new Map<string, Handle>();
export function createAudioHandle(chatId: string, ownerId: string, bytes: Buffer, mimeType = "audio/wav"): string {
  const id = randomUUID();
  handles.set(id, { chatId, ownerId, bytes, mimeType, createdAt: Date.now() });
  return id;
}
export function readAudioHandle(
  id: string,
  chatId: string,
  ownerId: string,
): { bytes: Buffer; mimeType: string } | null {
  const h = handles.get(id);
  if (!h || h.chatId !== chatId || h.ownerId !== ownerId) return null;
  if (Date.now() - h.createdAt > 120000) {
    handles.delete(id);
    return null;
  }
  return { bytes: h.bytes, mimeType: h.mimeType };
}
export function discardAudioHandle(id: string): void {
  handles.delete(id);
}
