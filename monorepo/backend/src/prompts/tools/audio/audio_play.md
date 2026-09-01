Play a WAV file and wait until playback finishes.

Example using the default output device:

```json
{ "source": { "kind": "file", "path": "recordings/answer.wav" } }
```

The source may instead be a chat `attachment` filename or trusted transient `handle`. To choose an output, add `"device":"Headphones"`.
