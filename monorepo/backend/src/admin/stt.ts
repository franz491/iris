import { randomBytes } from "node:crypto";
import { readBoundedResponse } from "../api/binary-limits.js";
import { pinnedFetch } from "../net/pinned-http.js";

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface SttClient {
  baseUrl: string;
  bearerToken?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function multipartAudio(audio: Uint8Array, filename: string): { body: ArrayBuffer; contentType: string } {
  const safeFilename = filename.slice(0, 255).replace(/["\r\n\\/]/g, "_") || "audio.wav";
  const boundary = `iris-${randomBytes(16).toString("hex")}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      "Content-Type: audio/wav\r\n\r\n",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Uint8Array.from(Buffer.concat([header, Buffer.from(audio), footer])).buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function transcribeAudio(
  client: SttClient,
  audio: Uint8Array,
  filename = "audio.wav",
): Promise<{ text: string; language?: string }> {
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error("audio exceeds 50MB limit");
  const timeoutMs = client.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("STT timeout is invalid");
  }
  const multipart = multipartAudio(audio, filename);
  const controller = new AbortController();
  const abortCaller = () => controller.abort(client.signal?.reason);
  if (client.signal?.aborted) abortCaller();
  else client.signal?.addEventListener("abort", abortCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("STT service timed out")), timeoutMs);
  try {
    const url = new URL("/v1/audio/transcriptions", client.baseUrl);
    const init: RequestInit = {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": multipart.contentType,
        ...(client.bearerToken ? { authorization: `Bearer ${client.bearerToken}` } : {}),
      },
      body: multipart.body,
    };
    const response = client.fetchImpl
      ? await client.fetchImpl(url, init)
      : await pinnedFetch(url, init, MAX_RESPONSE_BYTES, timeoutMs);
    if (!response.ok) throw new Error(`STT service returned ${response.status}`);
    const bytes = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
    let result: unknown;
    try {
      result = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("STT response was not valid JSON");
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("STT response was invalid");
    const record = result as Record<string, unknown>;
    if (typeof record.text !== "string" || Buffer.byteLength(record.text, "utf8") > 512 * 1024) {
      throw new Error("STT response omitted text");
    }
    return {
      text: record.text,
      ...(typeof record.language === "string" && record.language.length <= 128 ? { language: record.language } : {}),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      if (client.signal?.aborted) throw new Error("STT request aborted");
      throw new Error("STT service timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    client.signal?.removeEventListener("abort", abortCaller);
  }
}
