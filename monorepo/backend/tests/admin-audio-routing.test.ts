import { describe, expect, it } from "vitest";
import { chooseAudioRoute } from "../src/admin/audio-routing.js";
describe("audio routing", () => {
  it("requires explicit capability before native input", () => {
    expect(chooseAudioRoute(undefined, false).mode).toBe("unsupported");
    expect(chooseAudioRoute(undefined, true).mode).toBe("stt-fallback");
    expect(chooseAudioRoute({ inputAudio: true, outputAudio: false }, false).mode).toBe("native-audio");
  });
});
