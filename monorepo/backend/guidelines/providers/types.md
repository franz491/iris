ProviderDescriptor

name: string
description: string
options: ProviderFunctionality[]
additionalConfig: zodJsonSchema


ProviderFunctionality

name: string
description: string
kwargsSchema: zodJSONSchema //just a JSON, but I'm making it explicit
returnSchema: zodJSONSchema


ProviderRequest<Kwargs, Response>

provider: string
functionality: string
kwargs: Kwargs

## ASSUMPTIONS
- kwargsSchema/returnSchema/additionalConfig typed as loose Record<string, unknown> (JSON schema objects produced via zod-to-json-schema). Zod is the authoring DX; schemas are serialized to JSON for descriptors/plugin consumption.
- ProviderRequest generics loosened to unknown defaults.
