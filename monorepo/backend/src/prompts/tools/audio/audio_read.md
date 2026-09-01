Record `seconds` (0.1–300) from a microphone. Ask for permission immediately before every recording.

Example after permission:

```json
{ "seconds": 5, "device": "USB Mic" }
```

Omit `device` for the default input. The recording is saved under `recordings/` in the active files sandbox and the result contains its `filename`.
