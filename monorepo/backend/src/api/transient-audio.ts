import { randomUUID } from "node:crypto";
import { readRuntimeLimits } from "../config/runtime-limits.js";

interface TransientAudio {
  chatId: string;
  bytes: Buffer;
  mimeType: string;
  expiresAt: number;
}

const audio = new Map<string, TransientAudio>();
const TTL_MS = 2 * 60_000;

function normalizedMime(mimeType: string): string {
  const value = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (!value || !/^audio\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(value)) throw new Error("invalid audio MIME type");
  return value;
}

function reap(now: number): void {
  for (const [token, item] of audio) if (item.expiresAt <= now) audio.delete(token);
}

export function registerTransientAudio(chatId: string, bytes: Buffer, mimeType = "audio/wav"): string {
  const limits = readRuntimeLimits();
  if (bytes.byteLength > limits.audioHandleBytes || bytes.byteLength > limits.transientAudioBytes)
    throw new Error("audio exceeds configured limit");
  const normalized = normalizedMime(mimeType);
  const now = Date.now();
  reap(now);
  let total = 0;
  for (const item of audio.values()) total += item.bytes.byteLength;
  while (audio.size >= limits.transientAudioEntries || total + bytes.byteLength > limits.transientAudioBytes) {
    const oldest = audio.keys().next().value as string | undefined;
    if (!oldest) break;
    const item = audio.get(oldest);
    audio.delete(oldest);
    total -= item?.bytes.byteLength ?? 0;
  }
  const token = randomUUID();
  audio.set(token, { chatId, bytes, mimeType: normalized, expiresAt: now + TTL_MS });
  const timer = setTimeout(() => audio.delete(token), TTL_MS);
  timer.unref();
  return token;
}

export function discardTransientAudio(token: string): void {
  audio.delete(token);
}

export function getTransientAudio(token: string): TransientAudio | null {
  const item = audio.get(token);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    audio.delete(token);
    return null;
  }
  return item;
}
