/**
 * Derived from monotykamary/pi-tps, originally from badlogic/pi-mono.
 * See ../NOTICE and ../LICENSE for attribution and license terms.
 * SPDX-License-Identifier: MIT
 */
import type { StopReason, Usage } from "@earendil-works/pi-ai";

interface SessionManagerView {
  getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
}

export const REQUEST_ENTRY_TYPE = "pi-tps/request/v2";
export const PROMPT_ENTRY_TYPE = "pi-tps/prompt/v2";
export const PROMPT_DISPLAY_MESSAGE_TYPE = "pi-tps/prompt-display/v1";
const LEGACY_REQUEST_ENTRY_TYPE = "pi-tps/request/v1";
const LEGACY_PROMPT_ENTRY_TYPE = "pi-tps/prompt/v1";

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

export type TpsBranch = "primary" | "fallback" | "unavailable";
export type TpsUnavailableReason =
  | "no-output"
  | "insufficient-updates"
  | "insufficient-duration"
  | "implausible-rate";

export interface TpsMeasurementInput {
  outputTokens: number;
  generationMs: number | null;
  streamMs: number | null;
  postFirstUpdateCount: number;
  stallMs: number;
  forceFallback?: boolean;
}

export interface TpsMeasurement {
  tps: number | null;
  effectiveMs: number | null;
  branch: TpsBranch;
  unavailableReason?: TpsUnavailableReason;
}

export interface RequestMetrics {
  version: 1 | 2;
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
  ttftMs: number | null;
  generationMs: number | null;
  streamMs?: number | null;
  postFirstUpdateCount?: number;
  effectiveGenerationMs?: number | null;
  tpsBranch?: TpsBranch;
  tpsUnavailableReason?: TpsUnavailableReason;
  stallMs: number;
  stallCount: number;
  totalMs: number;
  outputTps: number | null;
  stopReason: StopReason;
  error?: string;
}

export interface PromptMetrics {
  version: 1 | 2;
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  requestCount: number;
  usage: TokenUsage;
  modelMs: number;
  generationMs: number;
  stallMs: number;
  stallCount: number;
  ttftMs: number | null;
  activeTps: number | null;
  effectiveTps: number | null;
  effectiveGenerationMs?: number | null;
  tpsBranch?: TpsBranch;
  tpsUnavailableReason?: TpsUnavailableReason;
  status: "completed" | "error" | "aborted";
}

export interface SessionMetrics {
  promptCount: number;
  requestCount: number;
  usage: TokenUsage;
  processingMs: number;
  modelMs: number;
  generationMs: number;
  activeTps: number | null;
  effectiveTps: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  requestTpsP50: number | null;
  requestTpsP95: number | null;
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

export function rate(tokens: number, durationMs: number): number | null {
  if (tokens <= 0 || durationMs <= 0) return null;
  return tokens / (durationMs / 1000);
}

/**
 * Measure generation TPS using a reliable streaming window when available,
 * then fall back to the full generation window. Unidentifiable or implausible
 * measurements return null instead of reporting a misleading rate.
 */
export function measureTps(input: TpsMeasurementInput): TpsMeasurement {
  const { outputTokens, generationMs, streamMs, postFirstUpdateCount, forceFallback = false } = input;
  if (outputTokens <= 0) {
    return { tps: null, effectiveMs: null, branch: "unavailable", unavailableReason: "no-output" };
  }

  const stallMs = Math.max(input.stallMs, 0);
  const MIN_STREAM_UPDATES = 5;
  const MIN_INTER_CHUNK_MS = 1;
  const MIN_GENERATION_MS = 200;
  const STALL_DOMINANCE_RATIO = 0.85;
  const STALL_REDUCTION_DENOM = 2;
  const MAX_PLAUSIBLE_TPS = 10_000;
  const averageGapMs = streamMs !== null && postFirstUpdateCount > 0
    ? streamMs / postFirstUpdateCount
    : 0;

  let effectiveMs: number;
  let branch: Exclude<TpsBranch, "unavailable">;
  if (!forceFallback
    && streamMs !== null
    && postFirstUpdateCount >= MIN_STREAM_UPDATES
    && averageGapMs >= MIN_INTER_CHUNK_MS
    && streamMs - stallMs >= MIN_GENERATION_MS
    && stallMs < streamMs - stallMs) {
    effectiveMs = streamMs - stallMs;
    branch = "primary";
  } else if (generationMs !== null
    && generationMs >= MIN_GENERATION_MS
    && postFirstUpdateCount >= 2) {
    const activeMs = generationMs - stallMs;
    effectiveMs = activeMs < MIN_GENERATION_MS || stallMs > generationMs * STALL_DOMINANCE_RATIO
      ? Math.max(generationMs - stallMs / STALL_REDUCTION_DENOM, MIN_GENERATION_MS)
      : Math.max(activeMs, MIN_GENERATION_MS);
    branch = "fallback";
  } else {
    const unavailableReason = postFirstUpdateCount < 2 ? "insufficient-updates" : "insufficient-duration";
    return { tps: null, effectiveMs: null, branch: "unavailable", unavailableReason };
  }

  const tps = outputTokens / (effectiveMs / 1000);
  if (tps > MAX_PLAUSIBLE_TPS) {
    return { tps: null, effectiveMs: null, branch: "unavailable", unavailableReason: "implausible-rate" };
  }
  return { tps, effectiveMs, branch };
}

/** @deprecated Use measureTps() with stream reliability data. */
export function rateAfterStall(tokens: number, generationMs: number | null, stallMs: number): number | null {
  return measureTps({
    outputTokens: tokens,
    generationMs,
    streamMs: null,
    postFirstUpdateCount: 2,
    stallMs,
    forceFallback: true,
  }).tps;
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
  const generationMs = requests.reduce((total, request) => total + (request.generationMs ?? 0), 0);
  const stallMs = requests.reduce((total, request) => total + request.stallMs, 0);
  const stallCount = requests.reduce((total, request) => total + request.stallCount, 0);
  const modelMs = requests.reduce((total, request) => total + request.totalMs, 0);
  const first = requests[0];
  const last = requests.at(-1);
  const outputRequests = requests.filter((request) => request.usage.output > 0);
  const allMeasurable = outputRequests.length > 0
    && outputRequests.every((request) => request.outputTps !== null && request.effectiveGenerationMs != null);
  const effectiveMs = allMeasurable
    ? outputRequests.reduce((total, request) => total + (request.effectiveGenerationMs ?? 0), 0)
    : null;
  const hasFallback = outputRequests.some((request) => request.tpsBranch === "fallback");
  const unavailableRequest = outputRequests.find((request) => request.tpsBranch === "unavailable");
  const measurement: TpsMeasurement = effectiveMs === null
    ? {
        tps: null,
        effectiveMs: null,
        branch: "unavailable",
        unavailableReason: unavailableRequest?.tpsUnavailableReason ?? "insufficient-updates",
      }
    : {
        tps: rate(usage.output, effectiveMs),
        effectiveMs,
        branch: hasFallback ? "fallback" : "primary",
      };
  const status = last?.stopReason === "aborted"
    ? "aborted"
    : last?.stopReason === "error"
      ? "error"
      : "completed";
  return {
    version: 2,
    id,
    startedAt,
    completedAt,
    durationMs,
    requestCount: requests.length,
    usage,
    modelMs,
    generationMs,
    stallMs,
    stallCount,
    ttftMs: first?.ttftMs ?? null,
    activeTps: measurement.tps,
    effectiveTps: rate(usage.output, durationMs),
    effectiveGenerationMs: measurement.effectiveMs,
    tpsBranch: measurement.branch,
    ...(measurement.unavailableReason === undefined ? {} : { tpsUnavailableReason: measurement.unavailableReason }),
    status,
  };
}

export function aggregateSession(prompts: PromptMetrics[], requests: RequestMetrics[]): SessionMetrics {
  const usage = prompts.reduce((total, prompt) => addUsage(total, prompt.usage), emptyUsage());
  const processingMs = prompts.reduce((total, prompt) => total + prompt.durationMs, 0);
  const modelMs = prompts.reduce((total, prompt) => total + prompt.modelMs, 0);
  const generationMs = prompts.reduce((total, prompt) => total + prompt.generationMs, 0);
  const ttfts = prompts.flatMap((prompt) => prompt.ttftMs === null ? [] : [prompt.ttftMs]);
  const requestRates = requests.flatMap((request) => request.outputTps === null ? [] : [request.outputTps]);
  const outputPrompts = prompts.filter((prompt) => prompt.usage.output > 0);
  const allMeasurable = outputPrompts.length > 0
    && outputPrompts.every((prompt) => prompt.activeTps !== null && prompt.effectiveGenerationMs != null);
  const activeMs = allMeasurable
    ? outputPrompts.reduce((total, prompt) => total + (prompt.effectiveGenerationMs ?? 0), 0)
    : 0;
  return {
    promptCount: prompts.length,
    requestCount: requests.length,
    usage,
    processingMs,
    modelMs,
    generationMs,
    activeTps: allMeasurable ? rate(usage.output, activeMs) : null,
    effectiveTps: rate(usage.output, processingMs),
    ttftP50Ms: percentile(ttfts, 0.5),
    ttftP95Ms: percentile(ttfts, 0.95),
    requestTpsP50: percentile(requestRates, 0.5),
    requestTpsP95: percentile(requestRates, 0.95),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    && isFiniteNumber(usage.cost?.total);
}

export function isRequestMetrics(value: unknown): value is RequestMetrics {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RequestMetrics>;
  const baseValid = (request.version === 1 || request.version === 2)
    && typeof request.id === "string"
    && typeof request.promptId === "string"
    && isFiniteNumber(request.sequence)
    && isFiniteNumber(request.startedAt)
    && isFiniteNumber(request.completedAt)
    && isFiniteNumber(request.totalMs)
    && isFiniteNumber(request.stallMs)
    && isFiniteNumber(request.stallCount)
    && isTokenUsage(request.usage);
  if (!baseValid) return false;
  if (request.version === 1) return true;
  return (request.streamMs === null || isFiniteNumber(request.streamMs))
    && isFiniteNumber(request.postFirstUpdateCount)
    && (request.effectiveGenerationMs === null || isFiniteNumber(request.effectiveGenerationMs))
    && (request.tpsBranch === "primary" || request.tpsBranch === "fallback" || request.tpsBranch === "unavailable");
}

export function isPromptMetrics(value: unknown): value is PromptMetrics {
  if (!value || typeof value !== "object") return false;
  const prompt = value as Partial<PromptMetrics>;
  const baseValid = (prompt.version === 1 || prompt.version === 2)
    && typeof prompt.id === "string"
    && isFiniteNumber(prompt.startedAt)
    && isFiniteNumber(prompt.completedAt)
    && isFiniteNumber(prompt.durationMs)
    && isFiniteNumber(prompt.requestCount)
    && isFiniteNumber(prompt.stallMs)
    && isFiniteNumber(prompt.stallCount)
    && isTokenUsage(prompt.usage);
  if (!baseValid) return false;
  if (prompt.version === 1) return true;
  return (prompt.effectiveGenerationMs === null || isFiniteNumber(prompt.effectiveGenerationMs))
    && (prompt.tpsBranch === "primary" || prompt.tpsBranch === "fallback" || prompt.tpsBranch === "unavailable");
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
    if ((entry.customType === REQUEST_ENTRY_TYPE || entry.customType === LEGACY_REQUEST_ENTRY_TYPE)
      && isRequestMetrics(entry.data)) requests.push(entry.data);
    if ((entry.customType === PROMPT_ENTRY_TYPE || entry.customType === LEGACY_PROMPT_ENTRY_TYPE)
      && isPromptMetrics(entry.data)) prompts.push(entry.data);
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

export function promptStatus(prompt: PromptMetrics, sessionProcessingMs = prompt.durationMs): string {
  const parts = [
    `TPS ${formatRate(prompt.activeTps)} tok/s`,
    `TTFT ${formatDuration(prompt.ttftMs)}`,
    `in ${formatTokens(prompt.usage.input)}`,
    `out ${formatTokens(prompt.usage.output)}`,
  ];
  if (prompt.stallMs > 0) parts.push(`stall ${formatDuration(prompt.stallMs)}×${prompt.stallCount}`);
  const duration = formatDuration(prompt.durationMs);
  parts.push(sessionProcessingMs === prompt.durationMs
    ? duration
    : `${formatDuration(sessionProcessingMs)}(+${duration})`);
  return parts.join(" · ");
}

export function renderReport(prompts: PromptMetrics[]): string {
  if (prompts.length === 0) return "No completed prompts.";
  const lines: string[] = [];
  let sessionProcessingMs = 0;
  prompts.forEach((prompt) => {
    sessionProcessingMs += prompt.durationMs;
    lines.push(promptStatus(prompt, sessionProcessingMs));
  });
  return lines.join("\n");
}
