A provider giving support for audio in/out using decibri.

It should expose these functionalities:
- refresh_devices: find all in/out devices attached to your pc. Promise<string[]>
- stream_audio: outputs audio. The kwargs are the audio stream and the device identifier. Returns nothing.
- read_audio: inputs audio. The kwargs is just the devide id. Returns the audio stream.
- stream_xxx: xxx is a device id, it only streams to that device.
- read_xxx: xxx is a device id. it only reads from that device.

ADDITIONAL SETTINGS
- device blacklist - never show these devices
- device renamelist - rename X to Y
- min audio input - only read audio above a certain level

## ASSUMPTIONS
- decibri is unavailable/unverifiable as a dependency, so AudioProvider ships with descriptor/config surface (blacklist, renamelist, minAudioInput) implemented and playback/capture delegated to a pluggable AudioBackend interface. A concrete backend (decibri, alsa, coreaudio...) can be injected via setBackend(); without one, calls fail with no_backend.

## ANSWERS
- decibri was never a requirement — it just looked like a suitable NPM package for a unified device interface across ALSA/windows/JACK etc. Any equivalent solution works; implementation stays behind the AudioBackend interface.
