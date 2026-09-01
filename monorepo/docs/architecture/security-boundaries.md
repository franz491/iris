# Security boundaries

## Outbound service endpoints

Configured service endpoints must use `http` or `https`, and may not contain URL credentials or fragments. Known cloud metadata hostnames, IPv4 link-local addresses (`169.254.0.0/16`), and IPv6 unspecified/link-local addresses are rejected during service validation. See [`backend/src/admin/services.ts`](../../backend/src/admin/services.ts#L46-L74) and [`backend/tests/admin-services.test.ts`](../../backend/tests/admin-services.test.ts#L3-L4).

The built-in service defaults bind local services to loopback addresses: llama.cpp at `127.0.0.1:8080`, audio.cpp at `127.0.0.1:8100`, and ComfyUI at `127.0.0.1:8188`. Managed services are started with explicit loopback listen arguments where the default provides them. See [`backend/src/admin/services.ts`](../../backend/src/admin/services.ts#L12-L21).

Health probes use a five-second timeout and `redirect: "error"`; redirects are not followed. Probe response bodies are bounded before parsing, and protocol-specific response shapes are checked. See [`backend/src/admin/services.ts`](../../backend/src/admin/services.ts#L79-L96).

These controls establish URL validation and probe behavior. They do not document a general DNS-rebinding defense or guarantee that every future service client applies the same policy; those remain documentation and implementation gaps unless separately enforced.
