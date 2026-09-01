Provider

providerDescriptor
setConfig(newConfig)
subscribe(event: string, callback)

by default, the events can be all the provider's functionality names, plus "request", "response", "reload", "error"

## ASSUMPTIONS
- Added `callFunctionality(functionality, kwargs)` to the interface: the kernel needs an invocation entrypoint, which the original spec omitted.
- BaseProvider implements subscribe() over a Node EventEmitter and provides helpers (isFunctionalityActive, typed settings accessor).
- Events emitted: functionality names on invocation plus reload/error where relevant ("request"/"response" events are emitted per-functionality by name instead).
