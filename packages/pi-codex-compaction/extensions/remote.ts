import type { Context, Model, Provider, Usage } from "@earendil-works/pi-ai";
import {
  CodexCompactionProtocolError,
  type CollectedCompaction,
  collectCompactionSse,
  type JsonObject,
  prepareRemoteCompactionPayload,
} from "./protocol.js";
import {
  normalizeUrl,
  OPENAI_RESPONSES_API,
  type RemoteCompactionApi,
} from "./capability.js";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";

interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<RemoteCompactionApi>;
  context: Context;
  endpoint: string;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  signal: AbortSignal;
  priorCheckpoint?: PriorCheckpointPayload;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  usage: Usage;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export function mergeRemoteCompactionHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find(
    (key) => key.toLowerCase() === "x-codex-beta-features",
  );
  const features = new Set(
    (existingKey ? merged[existingKey] : "")
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  features.add(REMOTE_COMPACTION_FEATURE);
  if (existingKey && existingKey !== "x-codex-beta-features") delete merged[existingKey];
  merged["x-codex-beta-features"] = [...features].join(",");
  return merged;
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function validateNetworkRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  endpoint: string,
): void {
  let actual: string;
  try {
    actual = normalizeUrl(requestUrl(input));
  } catch {
    throw new CodexCompactionProtocolError("Provider produced an invalid compaction endpoint");
  }
  if (actual !== endpoint) {
    throw new CodexCompactionProtocolError(
      `Provider requested unexpected compaction endpoint ${actual}`,
    );
  }
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") {
    throw new CodexCompactionProtocolError("Remote compaction request must use POST");
  }
  const features = requestHeaders(input, init).get("x-codex-beta-features") ?? "";
  if (!features.split(",").map((value) => value.trim()).includes(REMOTE_COMPACTION_FEATURE)) {
    throw new CodexCompactionProtocolError("Provider omitted the Remote Compaction V2 feature header");
  }
}

function compactionRequestModel(
  model: Model<RemoteCompactionApi>,
  endpoint: string,
): Model<RemoteCompactionApi> {
  if (model.api !== OPENAI_RESPONSES_API) return { ...model, baseUrl: endpoint };
  const suffix = "/responses";
  if (!endpoint.endsWith(suffix)) {
    throw new CodexCompactionProtocolError(
      "OpenAI Responses compaction endpoint must end with /responses",
    );
  }
  return { ...model, baseUrl: normalizeUrl(endpoint.slice(0, -suffix.length)) };
}

export async function requestRemoteCompaction(
  request: RemoteCompactionRequest,
): Promise<RemoteCompactionResponse> {
  if (request.signal.aborted) throw abortError();
  const endpoint = normalizeUrl(request.endpoint);
  const providerModel = compactionRequestModel(request.model, endpoint);
  let sentInput: JsonObject[] | undefined;
  const inspections: Promise<
    { ok: true; value: CollectedCompaction } | { ok: false; error: unknown }
  >[] = [];
  const baseFetch = request.fetch ?? globalThis.fetch;
  const inspectedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    validateNetworkRequest(input, init, endpoint);
    const response = await baseFetch(input, init);
    if (!response.ok || !response.body) return response;
    const [providerBody, inspectionBody] = response.body.tee();
    inspections.push(
      collectCompactionSse(inspectionBody, { signal: request.signal }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    return new Response(providerBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;

  const stream = request.provider.stream(providerModel, request.context, {
    apiKey: request.apiKey,
    headers: mergeRemoteCompactionHeader(request.headers),
    env: request.env,
    signal: request.signal,
    transport: "sse",
    cacheRetention: "none",
    timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
    maxRetries: request.maxRetries ?? 2,
    fetch: inspectedFetch,
    onPayload: (payload) => {
      const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint);
      if (prepared.model !== request.model.id) {
        throw new CodexCompactionProtocolError("Provider payload used an unexpected model");
      }
      if (!Array.isArray(prepared.input) || !prepared.input.every(isObject)) {
        throw new CodexCompactionProtocolError("Prepared compaction payload has invalid input items");
      }
      sentInput = structuredClone(prepared.input.slice(0, -1)) as JsonObject[];
      return prepared;
    },
  });

  let usage = EMPTY_USAGE;
  for await (const event of stream) {
    if (request.signal.aborted) throw abortError();
    if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "Codex compaction request failed");
    }
    if (event.type === "done") usage = event.message.usage;
  }
  if (request.signal.aborted) throw abortError();
  if (!sentInput) throw new CodexCompactionProtocolError("Provider did not expose a request payload");
  if (!inspections.length) {
    throw new CodexCompactionProtocolError("Provider response did not expose an SSE body");
  }
  const inspection = await inspections.at(-1);
  if (request.signal.aborted) throw abortError();
  if (!inspection?.ok) throw inspection?.error ?? new Error("Remote compaction inspection failed");
  return { item: inspection.value.item, promptInput: sentInput, usage };
}
