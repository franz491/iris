it receives all requests, including info about the plugin, model etc. and routes them to openai-compat or other API interfaces to send the actual request. It bases itself on the apiRouter (e.g. "openai-compat") of the AiParticipant that the chat module sends along for the request.

## ASSUMPTIONS
- Router registry keyed by apiRouter string; "openai-compat" preinstalled. Endpoint URL/key come from IRIS_OPENAI_COMPAT_BASE_URL / IRIS_OPENAI_COMPAT_API_KEY env vars until per-participant endpoints exist in apiAdditionalFields.
- reasoning_content delta mapped to thoughtDelta (OpenRouter-style reasoning field).

## ANSWERS
- API keys are NOT stored per-participant as values. Routers receive a named key dictionary ("openai-work", "openrouter", ...); AiParticipants reference their key BY NAME. Keys themselves are admin-managed (CLI/config), never in the chat DB.

## IMPLEMENTED
- Named API-key store (model-router/keys.ts, <dataDir>/keys.db): admin CLI manages `key set|list|get|rm`; AiParticipant.apiKeyName references a stored key which is injected into the outgoing request only (never persisted on the participant or sent to the frontend).
