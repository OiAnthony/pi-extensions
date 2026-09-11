import type { StopReason, Usage } from "@earendil-works/pi-ai";

interface SessionManagerView {
  getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
}

export const REQUEST_ENTRY_TYPE = "pi-tps/request/v3";
export const PROMPT_ENTRY_TYPE = "pi-tps/prompt/v3";
export const PROMPT_DISPLAY_MESSAGE_TYPE = "pi-tps/prompt-display/v1";
const LEGACY_REQUEST_ENTRY_TYPES = new Set(["pi-tps/request/v1", "pi-tps/request/v2"]);
const LEGACY_PROMPT_ENTRY_TYPES = new Set(["pi-tps/prompt/v1", "pi-tps/prompt/v2"]);

export interface PromptDisplayData {
  version: 1;
  line: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** One completed provider request. Timings are observed facts, not inferred decode time. */
export interface RequestMetrics {
  version: 3;
  id: string;
  promptId: string;
  sequence: number;
  provider: string;
  model: string;
  api?: string;
  startedAt: number;
  completedAt: number;
  responseStatus?: number;
  usage: TokenUsage;
  headersMs: number | null;
  /** Provider request start to first non-empty content event. */
  ttftMs: number | null;
  /** Assistant message start to completion, when both lifecycle events exist. */
  responseMs: number | null;
  /** Provider request start to turn completion. */
  totalMs: number;
  stopReason: StopReason;
  error?: string;
}

/** One agent run, from before_agent_start until agent_end/agent_settled. */
export interface PromptMetrics {
  version: 3;
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  requestCount: number;
  usage: TokenUsage;
  modelMs: number;
  /** TTFT of the first provider request. */
  ttftMs: number | null;
  status: "completed" | "error" | "aborted";
}

export interface SessionMetrics {
  promptCount: number;
  requestCount: number;
  usage: TokenUsage;
  processingMs: number;
  modelMs: number;
  effectiveTps: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftSamples: number;
}

export interface RestoredMetrics {
  prompts: PromptMetrics[];
  requests: RequestMetrics[];
}

export function emptyUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function copyUsage(usage: Usage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

export function addUsage(target: TokenUsage, source: TokenUsage): TokenUsage {
  const reasoning = target.reasoning === undefined && source.reasoning === undefined
    ? undefined
    : (target.reasoning ?? 0) + (source.reasoning ?? 0);
  return {
    input: target.input + source.input,
    output: target.output + source.output,
    cacheRead: target.cacheRead + source.cacheRead,
    cacheWrite: target.cacheWrite + source.cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: target.totalTokens + source.totalTokens,
    cost: {
      input: target.cost.input + source.cost.input,
      output: target.cost.output + source.cost.output,
      cacheRead: target.cost.cacheRead + source.cost.cacheRead,
      cacheWrite: target.cost.cacheWrite + source.cost.cacheWrite,
      total: target.cost.total + source.cost.total,
    },
  };
}

/** Effective output throughput over an observed wall-clock interval. */
export function rate(tokens: number, durationMs: number): number | null {
  if (tokens <= 0 || durationMs <= 0) return null;
  return tokens / (durationMs / 1000);
}

export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}

export function aggregatePrompt(
  id: string,
  startedAt: number,
  completedAt: number,
  durationMs: number,
  requests: RequestMetrics[],
): PromptMetrics {
  const usage = requests.reduce((total, request) => addUsage(total, request.usage), emptyUsage());
  const modelMs = requests.reduce((total, request) => total + request.totalMs, 0);
  const first = requests[0];
  const last = requests.at(-1);
  const status = last?.stopReason === "aborted"
    ? "aborted"
    : last?.stopReason === "error"
      ? "error"
      : "completed";
  return {
    version: 3,
    id,
    startedAt,
    completedAt,
    durationMs,
    requestCount: requests.length,
    usage,
    modelMs,
    ttftMs: first?.ttftMs ?? null,
    status,
  };
}

export function aggregateSession(prompts: PromptMetrics[], requests: RequestMetrics[]): SessionMetrics {
  const usage = prompts.reduce((total, prompt) => addUsage(total, prompt.usage), emptyUsage());
  const processingMs = prompts.reduce((total, prompt) => total + prompt.durationMs, 0);
  const modelMs = prompts.reduce((total, prompt) => total + prompt.modelMs, 0);
  const ttfts = requests.flatMap((request) => request.ttftMs === null ? [] : [request.ttftMs]);
  return {
    promptCount: prompts.length,
    requestCount: prompts.reduce((total, prompt) => total + prompt.requestCount, 0),
    usage,
    processingMs,
    modelMs,
    effectiveTps: rate(usage.output, processingMs),
    ttftP50Ms: percentile(ttfts, 0.5),
    ttftP95Ms: percentile(ttfts, 0.95),
    ttftSamples: ttfts.length,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<TokenUsage>;
  return isFiniteNumber(usage.input)
    && isFiniteNumber(usage.output)
    && isFiniteNumber(usage.cacheRead)
    && isFiniteNumber(usage.cacheWrite)
    && isFiniteNumber(usage.totalTokens)
    && Boolean(usage.cost)
    && isFiniteNumber(usage.cost?.input)
    && isFiniteNumber(usage.cost?.output)
    && isFiniteNumber(usage.cost?.cacheRead)
    && isFiniteNumber(usage.cost?.cacheWrite)
    && isFiniteNumber(usage.cost?.total);
}

function isPromptStatus(value: unknown): value is PromptMetrics["status"] {
  return value === "completed" || value === "error" || value === "aborted";
}

export function isRequestMetrics(value: unknown): value is RequestMetrics {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RequestMetrics>;
  return request.version === 3
    && typeof request.id === "string"
    && typeof request.promptId === "string"
    && isFiniteNumber(request.sequence)
    && typeof request.provider === "string"
    && typeof request.model === "string"
    && isFiniteNumber(request.startedAt)
    && isFiniteNumber(request.completedAt)
    && isTokenUsage(request.usage)
    && isNullableFiniteNumber(request.headersMs)
    && isNullableFiniteNumber(request.ttftMs)
    && isNullableFiniteNumber(request.responseMs)
    && isFiniteNumber(request.totalMs)
    && typeof request.stopReason === "string";
}

export function isPromptMetrics(value: unknown): value is PromptMetrics {
  if (!value || typeof value !== "object") return false;
  const prompt = value as Partial<PromptMetrics>;
  return prompt.version === 3
    && typeof prompt.id === "string"
    && isFiniteNumber(prompt.startedAt)
    && isFiniteNumber(prompt.completedAt)
    && isFiniteNumber(prompt.durationMs)
    && isFiniteNumber(prompt.requestCount)
    && isTokenUsage(prompt.usage)
    && isFiniteNumber(prompt.modelMs)
    && isNullableFiniteNumber(prompt.ttftMs)
    && isPromptStatus(prompt.status);
}

function normalizeLegacyRequest(value: unknown): RequestMetrics | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if ((request.version !== 1 && request.version !== 2)
    || typeof request.id !== "string"
    || typeof request.promptId !== "string"
    || !isFiniteNumber(request.sequence)
    || typeof request.provider !== "string"
    || typeof request.model !== "string"
    || !isFiniteNumber(request.startedAt)
    || !isFiniteNumber(request.completedAt)
    || !isTokenUsage(request.usage)
    || !isNullableFiniteNumber(request.headersMs)
    || !isNullableFiniteNumber(request.ttftMs)
    || !isFiniteNumber(request.totalMs)
    || typeof request.stopReason !== "string") return null;
  const generationMs = isNullableFiniteNumber(request.generationMs) ? request.generationMs : null;
  return {
    version: 3,
    id: request.id,
    promptId: request.promptId,
    sequence: request.sequence,
    provider: request.provider,
    model: request.model,
    ...(typeof request.api === "string" ? { api: request.api } : {}),
    startedAt: request.startedAt,
    completedAt: request.completedAt,
    ...(isFiniteNumber(request.responseStatus) ? { responseStatus: request.responseStatus } : {}),
    usage: request.usage,
    headersMs: request.headersMs,
    ttftMs: request.ttftMs,
    responseMs: generationMs,
    totalMs: request.totalMs,
    stopReason: request.stopReason as StopReason,
    ...(typeof request.error === "string" ? { error: request.error } : {}),
  };
}

function normalizeLegacyPrompt(value: unknown): PromptMetrics | null {
  if (!value || typeof value !== "object") return null;
  const prompt = value as Record<string, unknown>;
  if ((prompt.version !== 1 && prompt.version !== 2)
    || typeof prompt.id !== "string"
    || !isFiniteNumber(prompt.startedAt)
    || !isFiniteNumber(prompt.completedAt)
    || !isFiniteNumber(prompt.durationMs)
    || !isFiniteNumber(prompt.requestCount)
    || !isTokenUsage(prompt.usage)
    || !isFiniteNumber(prompt.modelMs)
    || !isNullableFiniteNumber(prompt.ttftMs)
    || !isPromptStatus(prompt.status)) return null;
  return {
    version: 3,
    id: prompt.id,
    startedAt: prompt.startedAt,
    completedAt: prompt.completedAt,
    durationMs: prompt.durationMs,
    requestCount: prompt.requestCount,
    usage: prompt.usage,
    modelMs: prompt.modelMs,
    ttftMs: prompt.ttftMs,
    status: prompt.status,
  };
}

export function isPromptDisplayData(value: unknown): value is PromptDisplayData {
  return value !== null
    && typeof value === "object"
    && "version" in value
    && value.version === 1
    && "line" in value
    && typeof value.line === "string";
}

export function restoreMetrics(sessionManager: SessionManagerView): RestoredMetrics {
  const prompts: PromptMetrics[] = [];
  const requests: RequestMetrics[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === REQUEST_ENTRY_TYPE && isRequestMetrics(entry.data)) requests.push(entry.data);
    else if (entry.customType && LEGACY_REQUEST_ENTRY_TYPES.has(entry.customType)) {
      const request = normalizeLegacyRequest(entry.data);
      if (request) requests.push(request);
    }
    if (entry.customType === PROMPT_ENTRY_TYPE && isPromptMetrics(entry.data)) prompts.push(entry.data);
    else if (entry.customType && LEGACY_PROMPT_ENTRY_TYPES.has(entry.customType)) {
      const prompt = normalizeLegacyPrompt(entry.data);
      if (prompt) prompts.push(prompt);
    }
  }
  return { prompts, requests };
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "n/a";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

export function promptStatus(prompt: PromptMetrics): string {
  const requestLabel = prompt.requestCount === 1 ? "1 request" : `${prompt.requestCount} requests`;
  return [
    formatDuration(prompt.durationMs),
    `${formatRate(rate(prompt.usage.output, prompt.durationMs))} tok/s`,
    requestLabel,
    `TTFT ${formatDuration(prompt.ttftMs)}`,
    `in ${formatTokens(prompt.usage.input)}`,
    `out ${formatTokens(prompt.usage.output)}`,
  ].join(" · ");
}

export function renderReport(prompts: PromptMetrics[], requests: RequestMetrics[] = []): string {
  if (prompts.length === 0) return "No completed prompts.";
  const lines = prompts.map(promptStatus);
  const session = aggregateSession(prompts, requests);
  const promptLabel = session.promptCount === 1 ? "1 prompt" : `${session.promptCount} prompts`;
  const requestLabel = session.requestCount === 1 ? "1 request" : `${session.requestCount} requests`;
  lines.push(
    `${promptLabel} · ${requestLabel} · ${formatRate(session.effectiveTps)} tok/s · processing ${formatDuration(session.processingMs)}`,
  );
  if (session.ttftSamples > 0) {
    lines.push(
      `TTFT p50 ${formatDuration(session.ttftP50Ms)} · p95 ${formatDuration(session.ttftP95Ms)} · n=${session.ttftSamples}`,
    );
  }
  return lines.join("\n");
}
