kernel.ts - orchestrates the components

EXPORTS

kernel: Kernel (as frozen object)

FUNCTIONALITY

on start, it should activate the config parser. It should receive the provider config from the config-parser which specifies:
- what providers are active (e.g. files, but not audio)
- what services of that provider are active (file read but not write)
- additional settings specific to a provider

It initialises the provider with the given settings. On SetConfig, it reinitializes is (if busy, it gets put in queue until it stops being busy, unless forced). When setConfig is called again for the same provider it removes previous calls in queue if any.

It only allows calls of given providers based on whether the config allows it. It allows modifications to the config while it's running. providers can add and remove functionalities while running, too, but a settings update is required before those functionalities can be used if they're not in the config already.

on sendRequest it sends the request to the correct provider, then gives the response back.

## ASSUMPTIONS
- Providers are registered via a factory registry (`registerProviderFactory`); installed providers self-register from providers/installed/index.ts.
- Provider status transitions: Waiting (idle), Busy (during init or functionality execution), Error (init failure), Inactive (unused for now).
- "if busy, put in queue" applies to reconfiguration only: a queued setConfig replaces any earlier queued one for the same provider (last-wins), matching your dedup requirement.
- Functionality calls are refused when not listed in the provider's active config (config gating).
- useProvider gained an explicit `functionality` argument; sendRequest delegates to it.
- The frozen export is `frozenKernel`; `kernel` remains mutable internally for wiring/tests.
