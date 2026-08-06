import type { Api, Model } from "@earendil-works/pi-ai";
import { hasApi } from "@earendil-works/pi-ai";

export const CODEX_API = "openai-codex-responses" as const;
export const OPENAI_RESPONSES_API = "openai-responses" as const;
export type RemoteCompactionApi = typeof CODEX_API | typeof OPENAI_RESPONSES_API;
export const REQUEST_TIMEOUT_MS = 300_000;
export const MAX_RETRIES = 2;
export const REPLACEMENT_TOKEN_BUDGET = 64_000;

const OFFICIAL_PROVIDER = "openai-codex";
const OFFICIAL_BASE_URL = "https://chatgpt.com/backend-api";

export interface RemoteCompactionCapability {
  protocol: "v2";
  endpoint: string;
}

export interface CapableModel {
  model: Model<RemoteCompactionApi>;
  baseUrl: string;
  capability: RemoteCompactionCapability;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function deriveEndpoint(baseUrl: string, api: RemoteCompactionApi): string {
  if (api === OPENAI_RESPONSES_API) {
    const versionedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    return `${versionedBaseUrl}/responses`;
  }
  if (baseUrl.endsWith("/codex/responses")) return baseUrl;
  if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

function configuredCapability(model: Model<Api>, baseUrl: string): RemoteCompactionCapability | undefined {
  const compat = model.compat as Record<string, unknown> | undefined;
  const value = compat?.remoteCompaction;
  if (
    !isRecord(value) ||
    value.protocol !== "v2" ||
    (value.endpoint !== undefined && typeof value.endpoint !== "string")
  ) {
    return undefined;
  }
  try {
    const endpoint =
      typeof value.endpoint === "string"
        ? normalizeUrl(value.endpoint)
        : deriveEndpoint(baseUrl, model.api as RemoteCompactionApi);
    if (new URL(baseUrl).origin !== new URL(endpoint).origin) return undefined;
    return { protocol: "v2", endpoint };
  } catch {
    return undefined;
  }
}

export function capableModel(model: Model<Api> | undefined): CapableModel | undefined {
  if (
    !model ||
    (model.api !== CODEX_API && model.api !== OPENAI_RESPONSES_API)
  ) {
    return undefined;
  }
  const remoteModel = model as Model<RemoteCompactionApi>;
  let baseUrl: string;
  try {
    baseUrl = normalizeUrl(remoteModel.baseUrl);
  } catch {
    return undefined;
  }

  const capability =
    model.provider === OFFICIAL_PROVIDER &&
    hasApi(remoteModel, CODEX_API) &&
    baseUrl === OFFICIAL_BASE_URL
      ? { protocol: "v2" as const, endpoint: deriveEndpoint(baseUrl, CODEX_API) }
      : configuredCapability(remoteModel, baseUrl);
  return capability ? { model: remoteModel, baseUrl, capability } : undefined;
}
