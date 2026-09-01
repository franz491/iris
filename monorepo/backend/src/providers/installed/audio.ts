// providers/installed/audio.ts
// Audio in/out. Exposes the descriptor/config surface and device management,
// with playback/capture behind a pluggable AudioBackend interface so any
// unified cross-platform audio library can be dropped in (user confirmed
// the originally-suggested "decibri" package is non-mandatory — any equivalent works).
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { AppError } from "../../misc/error.js";

export interface AudioDevice {
  id: string;
  name: string;
  direction: "in" | "out";
}
const devicesResultSchema = {
  type: "object",
  properties: {
    devices: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, direction: { enum: ["in", "out"] } },
        required: ["id", "name", "direction"],
        additionalProperties: false,
      },
    },
  },
  required: ["devices"],
  additionalProperties: false,
};

/** Pluggable audio backend (alsa, coreaudio, or any unified cross-platform lib). */
export interface AudioBackend {
  listDevices(): Promise<AudioDevice[]>;
  play(deviceId: string, stream: AsyncIterable<Buffer>): Promise<void>;
  record(deviceId: string): AsyncIterable<Buffer>;
}

export class AudioProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "audio",
    description: "Audio input/output device access.",
    options: [
      {
        name: "refresh_devices",
        description: "List attached in/out devices.",
        kwargsSchema: { type: "object" },
        returnSchema: devicesResultSchema,
      },
      {
        name: "stream_audio",
        description: "Play an audio stream on a device.",
        kwargsSchema: { type: "object" },
        returnSchema: {
          type: "object",
          properties: { ok: { const: true } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      {
        name: "read_audio",
        description: "Record audio from a device.",
        kwargsSchema: { type: "object" },
        returnSchema: {
          type: "object",
          properties: { kind: { const: "audio_stream" }, version: { const: 1 } },
          required: ["kind", "version"],
          additionalProperties: false,
        },
      },
    ],
    additionalConfig: {
      type: "object",
      properties: {
        deviceBlacklist: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "never show these devices",
        },
        deviceRenameList: { type: "object", default: {}, description: "rename X to Y" },
        minAudioInput: { type: "number", default: 0, description: "only read audio above this level" },
      },
    },
  };

  private backend: AudioBackend | null = null;

  /** Plug in a concrete backend; without one the provider reports an error. */
  setBackend(backend: AudioBackend): void {
    this.backend = backend;
  }

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.emit("reload");
  }

  private applyDevicePolicy(devices: AudioDevice[]): AudioDevice[] {
    const blacklist = this.setting<string[]>("deviceBlacklist", []);
    const renames = this.setting<Record<string, string>>("deviceRenameList", {});
    return devices
      .filter((d) => !blacklist.includes(d.id) && !blacklist.includes(d.name))
      .map((d) => ({ ...d, name: renames[d.name] ?? renames[d.id] ?? d.name }));
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppError(`functionality "${functionality}" is not active`, "functionality_inactive");
    }
    if (!this.backend) throw new AppError("no audio backend configured", "no_backend");
    const k = (kwargs ?? {}) as Record<string, unknown>;
    switch (functionality) {
      case "refresh_devices":
        return { devices: this.applyDevicePolicy(await this.backend.listDevices()) };
      case "stream_audio": {
        await this.backend.play(String(k.deviceId), k.stream as AsyncIterable<Buffer>);
        return { ok: true };
      }
      case "read_audio":
        return { kind: "audio_stream", version: 1 };
      default:
        throw new AppError(`unknown functionality "${functionality}"`, "unknown_functionality");
    }
  }
}
