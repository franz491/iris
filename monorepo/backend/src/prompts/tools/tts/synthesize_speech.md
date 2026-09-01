Generate speech from text and immediately play it for connected chat users.

Use `language` when it is known. For Qwen3 CustomVoice, provide the configured built-in speaker name in `voice` (for example `Serena`, `Vivian`, or `Ryan`). Use `instruct` for delivery such as pace, tone, or emotion. For cloning-capable models, `voiceRef` must be a WAV path, and `referenceText` should contain its transcript when required. `..` is unallowed in paths; paths may be relative or absolute paths from your `be_files` point of view. After a successful call, assume playback was started. Call this tool only to follow a user request for speech or audio. Do not use it to repeat routine assistant replies word-for-word, and do not automatically produce both spoken and written versions of every answer.

Example:

```json
{ "text": "Your timer is complete.", "language": "en", "voice": "Ryan", "instruct": "calm and clear" }
```

Qwen3 CustomVoice example:

```json
{ "text": "Hi there! I'm here!", "language": "en", "voice": "Serena", "instruct": "cheerful and energetic" }
```

Voice-cloning example:

```json
{
  "text": "Hello. How are you?",
  "language": "en",
  "voiceRef": "voice.wav",
  "referenceText": "<transcript of voice.wav, if available>",
  "instruct": "warm and friendly"
}
```
