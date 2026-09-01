import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor, SchemaObject } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { AppError } from "../../misc/error.js";
import { getAdminConfig } from "../../admin/store.js";
import path from "node:path";
import { readBoundedResponse } from "../../api/binary-limits.js";
import { getConfig } from "../../runtime/config-parser.js";
import { pinnedFetch } from "../../net/pinned-http.js";
import { readRuntimeLimits } from "../../config/runtime-limits.js";

const json = (schema: z.ZodTypeAny): SchemaObject => zodToJsonSchema(schema, { target: "openAi" }) as SchemaObject;

const synthesizeSchema = z.object({
  text: z.string().min(1).max(10_000),
  language: z.string().optional().default("Auto"),
  voice: z.string().optional(),
  instruct: z.string().max(2_000).optional(),
  voiceRef: z.union([z.string(), z.record(z.unknown())]).optional(),
  referenceText: z.string().max(10_000).optional(),
  options: z.record(z.unknown()).optional(),
  // Required provider-internal ownership context. The AI-facing tool schema
  // omits this field; executeProviderTool injects the trusted active chat ID.
  chatId: z.string().min(1),
});

export class TtsProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "tts",
    description: "Generate speech through an audio.cpp-compatible HTTP service.",
    options: [
      {
        name: "synthesize",
        description: "Synthesize text into a WAV chat attachment.",
        kwargsSchema: json(synthesizeSchema),
        returnSchema: {},
      },
    ],
    additionalConfig: {
      type: "object",
      properties: {
        baseUrl: { type: "string", default: "http://127.0.0.1:8100" },
        model: { type: "string", default: "pocket-tts", description: "audio.cpp model id" },
        timeoutMs: { type: "number", default: 120000 },
        bearerToken: { type: "string", description: "optional token expected by the external service" },
      },
    },
  };

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.emit("reload");
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppError(`functionality "${functionality}" is not active`, "functionality_inactive");
    }
    if (functionality !== "synthesize") {
      throw new AppError(`unknown functionality "${functionality}"`, "unknown_functionality");
    }
    const input = synthesizeSchema.parse(kwargs);
    const configuredService = (() => {
      try {
        return getAdminConfig().config.services.find((service) => service.kind === "audio" || service.kind === "tts");
      } catch {
        return undefined;
      }
    })();
    const audio = configuredService?.audioCpp;
    const family = audio?.family ?? "";
    const preset = audio?.defaultVoicePreset;
    const options: Record<string, unknown> = { ...(input.options ?? {}) };
    const model =
      this.setting<string>("model", "") || audio?.modelId || configuredService?.audioCpp?.modelId || "pocket-tts";
    const customVoice = family === "qwen3_tts" && /customvoice/i.test(`${model} ${audio?.modelPath ?? ""}`);
    if (!customVoice && (input.referenceText ?? preset?.referenceText))
      options.reference_text = input.referenceText ?? preset?.referenceText;
    if (!customVoice && (input.voiceRef ?? preset?.voiceRef)) options.voice_ref = input.voiceRef ?? preset?.voiceRef;
    if (family === "qwen3_tts" && (input.voice ?? preset?.speaker)) options.speaker = input.voice ?? preset?.speaker;
    if (typeof options.voice_ref === "string") {
      const cfg = await getConfig();
      const filesRoot = cfg.files?.additionalSettings?.rootFolder;
      if (typeof filesRoot !== "string" || !filesRoot.trim())
        throw new AppError("files folder is not configured", "tts_invalid_voice_ref");
      const relative = options.voice_ref.replaceAll("\\", "/").replace(/^\/+/, "");
      if (relative.split("/").some((part) => part === ".."))
        throw new AppError("voice reference must stay inside the files folder", "tts_invalid_voice_ref");
      options.voice_ref = path.join(path.resolve(filesRoot), ...relative.split("/").filter(Boolean));
    }
    const baseUrl = (
      this.setting<string>("baseUrl", "") ||
      configuredService?.endpoint.baseUrl ||
      "http://127.0.0.1:8100"
    ).replace(/\/+$/, "");
    const timeoutMs = this.setting<number>("timeoutMs", 120000);
    const token = this.setting<string>("bearerToken", "");
    const requestBody = JSON.stringify({
      model,
      input: input.text,
      language: input.language,
      ...(family === "qwen3_tts" ? {} : { voice: input.voice }),
      instruct: input.instruct,
      options: {
        ...options,
        ...(family === "qwen3_tts" && input.instruct ? { instruct: input.instruct } : {}),
      },
      response_format: "wav",
    });
    const limits = readRuntimeLimits();
    if (Buffer.byteLength(requestBody, "utf8") > limits.ttsRequestBytes) {
      throw new AppError(`TTS request exceeded ${limits.ttsRequestBytes} bytes`, "tts_invalid_request");
    }
    try {
      const maxBytes = limits.ttsAudioBytes;
      const response = await pinnedFetch(
        new URL(`${baseUrl}/v1/audio/speech`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: requestBody,
        },
        maxBytes,
        timeoutMs,
      );
      if (!response.ok) {
        const detail = (await readBoundedResponse(response, readRuntimeLimits().ttsErrorBytes))
          .toString("utf8")
          .slice(0, 500);
        throw new AppError(`TTS service failed (${response.status}): ${detail}`, "tts_failed");
      }
      const audio = await readBoundedResponse(response, maxBytes);
      if (audio.length < 44 || audio.length > maxBytes || audio.subarray(0, 4).toString("ascii") !== "RIFF") {
        throw new AppError("TTS service did not return a valid-sized WAV file", "tts_invalid_audio");
      }
      return {
        _irisAudio: {
          mimeType: "audio/wav",
          base64: audio.toString("base64"),
        },
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && /timed out/i.test(error.message))
        throw new AppError("TTS service timed out", "tts_timeout");
      throw new AppError(
        `TTS service unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "tts_unavailable",
      );
    }
  }
}
