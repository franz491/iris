export interface AudioCapabilities {
  inputAudio: boolean;
  outputAudio: boolean;
  testedAt?: string;
}
export interface AudioRoute {
  mode: "native-audio" | "stt-fallback" | "unsupported";
  reason: string;
}
export function chooseAudioRoute(capabilities: AudioCapabilities | undefined, sttConfigured: boolean): AudioRoute {
  if (capabilities?.inputAudio)
    return { mode: "native-audio", reason: "profile explicitly advertises tested input-audio support" };
  if (sttConfigured)
    return { mode: "stt-fallback", reason: "profile is text-only; configured STT service will provide a transcript" };
  return { mode: "unsupported", reason: "no tested native audio capability or STT fallback is configured" };
}
export function audioModelMetadata(capabilities: AudioCapabilities | undefined): {
  inputAudio: boolean;
  outputAudio: boolean;
} {
  return { inputAudio: Boolean(capabilities?.inputAudio), outputAudio: Boolean(capabilities?.outputAudio) };
}
