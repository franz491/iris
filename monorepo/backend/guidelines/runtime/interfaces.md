Kernel

getStatus(providerName: string): ProviderStatus
getFunctionality(providerName: string): ProviderFunctionality[]
useProvider<R>(name: string, kwargs: unknown): Promise<R>
setConfig(ProviderConfig[], force=false): Promise<void>
sendRequest<K,R>(req: ProviderRequest<K, R>): Promise<R>
