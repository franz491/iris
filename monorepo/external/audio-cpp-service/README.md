# audio.cpp service integration

## Lifecycle

This directory is documentation-only source, not a nested repository,
generated output, or install cache. The runtime binary is installed and
managed outside the repository.

This directory is a first-party documentation pointer, not vendored audio.cpp
source, a Git submodule, an installable package, or an artifact cache. Iris
connects to a separately installed upstream `audiocpp_server` binary; it does
not own the binary, its model files, or its update lifecycle. Keep this README
in the repository and keep installed software and models outside it (normally
under the machine-local `IRIS_DATA_DIR/software` while the managed installer is
used).

To update the integration, change this contract and the corresponding service
configuration code together. Do not add a copied upstream checkout here unless
a later decision explicitly adopts vendoring, license tracking, update
ownership, and reproducible build rules.

## Configuration contract

Iris uses the upstream `audiocpp_server` binary as its TTS runtime. Install
audio.cpp and its model assets separately, then configure the TTS service in
the Iris admin plane:

- executable: `audiocpp_server` (or an absolute path)
- model family and model path: the values required by the selected audio.cpp
  model
- backend/device/threads: the runtime placement for this host

The admin plane writes the audio.cpp server JSON to Iris's private data
directory when the managed service starts. Its process arguments use the
`{audioCppConfig}` placeholder, which Iris replaces with that generated path.
The service exposes the OpenAI-compatible `/v1/audio/speech` endpoint, so
generated WAV playback remains transient and chat-safe.
