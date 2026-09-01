import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type Address = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<Address[]>;
export type PinnedRequest = (
  url: URL,
  address: Address,
  signal: AbortSignal,
  init: RequestInit,
  maxBytes: number,
) => Promise<Response>;
export type RequestFactory = (
  url: URL,
  options: Record<string, unknown>,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;
let requestFactory: RequestFactory | undefined;
export function setPinnedRequestFactoryForTests(value?: RequestFactory): void {
  requestFactory = value;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((item) => ({
    address: item.address,
    family: item.family as 4 | 6,
  }));

let resolver: Resolver = defaultResolver;
let transport: PinnedRequest;

export function setPinnedResolverForTests(value?: Resolver): void {
  resolver = value ?? defaultResolver;
}

export function setPinnedRequestForTests(value?: PinnedRequest): void {
  transport = value ?? defaultPinnedRequest;
}

function isBlockedAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    return address === "::" || address === "::1" || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(address);
  }
  return true;
}

function literalLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

/**
 * Node may ask a custom lookup function for all results (notably when it is
 * establishing a connection with `autoSelectFamily`). In that case the
 * callback's second argument must be an array. Returning the scalar form for
 * an `all` lookup makes node:net treat the address as missing and eventually
 * throws ERR_INVALID_IP_ADDRESS for `undefined`.
 */
function pinnedLookup(address: Address) {
  return (
    _hostname: string,
    options: { all?: boolean } | ((...args: any[]) => void),
    callback?: (...args: any[]) => void,
  ) => {
    const cb: (...args: any[]) => void = typeof options === "function" ? options : callback!;
    if (typeof options !== "function" && options.all) {
      cb(null, [{ address: address.address, family: address.family }]);
    } else {
      cb(null, address.address, address.family);
    }
  };
}

export async function resolvePinned(url: URL): Promise<Address> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("unsafe outbound URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedAddress(hostname) && !literalLoopback(hostname)) {
      throw new Error("outbound URL targets a disallowed address");
    }
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  if (hostname.toLowerCase() === "localhost") return { address: "127.0.0.1", family: 4 };

  const addresses = await resolver(hostname);
  if (
    !addresses.length ||
    addresses.some(
      (item) => ![4, 6].includes(item.family) || isIP(item.address) !== item.family || isBlockedAddress(item.address),
    )
  ) {
    throw new Error("outbound URL resolves to a disallowed address");
  }
  return addresses[0];
}

function requestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("unsupported pinned request body type");
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(name, item);
    else if (value !== undefined) result.set(name, String(value));
  }
  return result;
}

export function responseLengthExceedsLimit(
  declaredLength: string | undefined,
  streamedBytes: number,
  maxBytes: number,
): boolean {
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) return true;
  }
  return streamedBytes > maxBytes;
}

export const defaultPinnedRequest: PinnedRequest = async (url, address, signal, init, maxBytes) =>
  new Promise((resolve, reject) => {
    const body = requestBody(init.body);
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    if (body) headers.set("content-length", String(body.byteLength));
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        lookup: pinnedLookup(address),
        servername: url.hostname,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declaredLength = response.headers["content-length"];
        if (responseLengthExceedsLimit(declaredLength, 0, maxBytes)) {
          const error = new Error("response body exceeds limit");
          reject(error);
          response.destroy(error);
          request.destroy(error);
          return;
        }
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (responseLengthExceedsLimit(undefined, size, maxBytes)) {
            const error = new Error("response body exceeds limit");
            reject(error);
            response.destroy(error);
            request.destroy(error);
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers: responseHeaders(response.headers),
            }),
          ),
        );
        response.on("error", reject);
      },
    );

    const abort = () =>
      request.destroy(signal.reason instanceof Error ? signal.reason : new Error("outbound request aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.on("error", reject);
    request.end(body);
  });

transport = defaultPinnedRequest;

export async function pinnedFetch(
  input: URL,
  init: RequestInit = {},
  maxBytes = 10 * 1024 * 1024,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new Error("invalid outbound response limit");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
    throw new Error("invalid outbound timeout");
  }
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortCaller();
  else callerSignal?.addEventListener("abort", abortCaller, { once: true });
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("outbound request timed out")), timeoutMs) : undefined;
  try {
    const address = await resolvePinned(input);
    return await transport(input, address, controller.signal, { ...init, signal: undefined }, maxBytes);
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortCaller);
  }
}

export async function pinnedFetchStream(
  input: URL,
  init: RequestInit = {},
  maxBytes = 8 * 1024 * 1024,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_RESPONSE_BYTES)
    throw new Error("invalid outbound response limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000)
    throw new Error("invalid outbound timeout");
  const controller = new AbortController();
  const caller = init.signal;
  const abort = () => controller.abort(caller?.reason);
  if (caller?.aborted) abort();
  else caller?.addEventListener("abort", abort, { once: true });
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("outbound request timed out")), timeoutMs) : undefined;
  let address: Address;
  try {
    address = await resolvePinned(input);
  } catch (error) {
    if (timer) clearTimeout(timer);
    caller?.removeEventListener("abort", abort);
    throw error;
  }
  return await new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    let errorBody: ((error: Error) => void) | undefined;
    const bodyBytes = requestBody(init.body);
    const headerBag = new Headers(init.headers);
    headerBag.set("host", input.host);
    if (bodyBytes) headerBag.set("content-length", String(bodyBytes.byteLength));
    const create =
      requestFactory ??
      ((url, options, callback) =>
        (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options as any, callback));
    const req = create(
      input,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headerBag.entries()),
        lookup: pinnedLookup(address),
        servername: input.hostname,
      },
      (res) => {
        const declaredRaw = res.headers["content-length"];
        if (responseLengthExceedsLimit(declaredRaw, 0, maxBytes)) {
          const e = new Error("stream response exceeds limit");
          req.destroy(e);
          reject(e);
          return;
        }
        res.pause();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            errorBody = (error) => {
              try {
                c.error(error);
              } catch {}
            };
            res.on("readable", () => {
              let chunk: Buffer | null;
              while ((chunk = res.read()) !== null) {
                total += chunk.length;
                if (total > maxBytes) {
                  const e = new Error("stream response exceeds limit");
                  c.error(e);
                  req.destroy(e);
                  return;
                }
                c.enqueue(chunk);
                if (c.desiredSize !== null && c.desiredSize <= 0) {
                  res.pause();
                  break;
                }
              }
            });
            res.on("end", () => {
              settled = true;
              try {
                c.close();
              } catch {}
              cleanup();
            });
            res.on("error", (e) => {
              settled = true;
              try {
                c.error(e);
              } catch {}
              cleanup();
            });
          },
          pull() {
            res.resume();
          },
          cancel(reason) {
            settled = true;
            req.destroy(reason instanceof Error ? reason : undefined);
            cleanup();
          },
        });
        resolve(new Response(body, { status: res.statusCode ?? 500, headers: responseHeaders(res.headers) }));
      },
    );
    const cleanup = () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", stop);
    };
    const stop = () => {
      if (!settled) {
        settled = true;
        const error =
          controller.signal.reason instanceof Error ? controller.signal.reason : new Error("outbound request aborted");
        errorBody?.(error);
        req.destroy(error);
        reject(error);
        cleanup();
      }
    };
    if (controller.signal.aborted) stop();
    else controller.signal.addEventListener("abort", stop, { once: true });
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
        cleanup();
      }
    });
    req.end(bodyBytes);
  });
}
