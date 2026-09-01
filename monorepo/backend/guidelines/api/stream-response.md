stream-response.ts - utilities for streaming AI responses to the frontend

## ASSUMPTIONS
- SSE chosen for AI response streaming (PushQueue + hono streamSSE); audio streaming is chunked binary passthrough in api/stream.ts.
