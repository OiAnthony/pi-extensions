/**
 * Derived from monotykamary/pi-tps, originally from badlogic/pi-mono.
 * See ../NOTICE and ../LICENSE for attribution and license terms.
 * SPDX-License-Identifier: MIT
 */
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  PROMPT_DISPLAY_MESSAGE_TYPE,
  PROMPT_ENTRY_TYPE,
  REQUEST_ENTRY_TYPE,
  aggregatePrompt,
  copyUsage,
  emptyUsage,
  isPromptDisplayData,
  promptStatus,
  rateAfterStall,
  renderReport,
  restoreMetrics,
  type PromptMetrics,
  type RequestMetrics,
} from "./core.js";

export interface Clock {
  now(): number;
  wallNow(): number;
}

export interface RuntimeDependencies {
  clock?: Clock;
}

interface ActiveRequest {
  id: string;
  sequence: number;
  provider: string;
  model: string;
  api?: string;
  startedAt: number;
  startedMono: number;
  headersMono?: number;
  firstDeltaMono?: number;
  lastUpdateMono?: number;
  stallMs: number;
  stallCount: number;
  inStall: boolean;
  messageEndMono?: number;
  responseStatus?: number;
}

/** Minimum gap between stream updates to count as an inference stall (ms). */
const STALL_THRESHOLD_MS = 500;

interface ActivePrompt {
  id: string;
  startedAt: number;
  startedMono: number;
  requests: RequestMetrics[];
  currentRequest?: ActiveRequest;
}

function defaultClock(): Clock {
  return {
    now: () => performance.now(),
    wallNow: () => Date.now(),
  };
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return message !== null && typeof message === "object" && "role" in message && message.role === "assistant";
}

function isFirstContentDelta(event: AssistantMessageEvent): boolean {
  return (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
    && event.delta.length > 0;
}

export default function register(pi: ExtensionAPI, dependencies: RuntimeDependencies = {}): void {
  const clock = dependencies.clock ?? defaultClock();
  let promptCounter = 0;
  let active: ActivePrompt | undefined;
  let prompts: PromptMetrics[] = [];
  let sessionProcessingMs = 0;

  pi.registerMessageRenderer(PROMPT_DISPLAY_MESSAGE_TYPE, (message, _options, theme) => {
    if (!isPromptDisplayData(message.details)) return undefined;
    return new Text(theme.fg("muted", message.details.line), 1, 0);
  });

  pi.registerEntryRenderer(PROMPT_DISPLAY_MESSAGE_TYPE, (entry, _options, theme) => {
    if (!isPromptDisplayData(entry.data)) return undefined;
    return new Text(theme.fg("muted", entry.data.line), 1, 0);
  });

  const restore = (ctx: ExtensionContext): void => {
    const restored = restoreMetrics(ctx.sessionManager);
    prompts = restored.prompts;
    sessionProcessingMs = prompts.reduce((total, prompt) => total + prompt.durationMs, 0);
    active = undefined;
  };

  const finalizeRequest = (
    request: ActiveRequest,
    message?: AssistantMessage,
    fallbackStopReason: "error" | "aborted" = "error",
  ): RequestMetrics => {
    const completedMono = clock.now();
    const completedAt = clock.wallNow();
    const generationMs = request.firstDeltaMono === undefined || request.messageEndMono === undefined
      ? null
      : Math.max(0, request.messageEndMono - request.firstDeltaMono);
    const usage = message ? copyUsage(message.usage) : emptyUsage();
    const metrics: RequestMetrics = {
      version: 1,
      id: request.id,
      promptId: active?.id ?? request.id.split(":")[0] ?? "unknown",
      sequence: request.sequence,
      provider: message?.provider ?? request.provider,
      model: message?.model ?? request.model,
      api: message?.api ?? request.api,
      startedAt: request.startedAt,
      completedAt,
      responseStatus: request.responseStatus,
      usage,
      headersMs: request.headersMono === undefined ? null : Math.max(0, request.headersMono - request.startedMono),
      ttftMs: request.firstDeltaMono === undefined ? null : Math.max(0, request.firstDeltaMono - request.startedMono),
      generationMs,
      stallMs: request.stallMs,
      stallCount: request.stallCount,
      totalMs: Math.max(0, completedMono - request.startedMono),
      outputTps: rateAfterStall(usage.output, generationMs, request.stallMs),
      stopReason: message?.stopReason ?? fallbackStopReason,
      ...(message?.errorMessage ? { error: message.errorMessage } : {}),
    };
    active?.requests.push(metrics);
    if (active?.currentRequest === request) active.currentRequest = undefined;
    return metrics;
  };

  const finalizeDanglingRequest = (reason: "error" | "aborted" = "error"): void => {
    if (!active?.currentRequest) return;
    finalizeRequest(active.currentRequest, undefined, reason);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    active = undefined;
  });

  pi.on("before_agent_start", () => {
    if (active) finalizeDanglingRequest("aborted");
    const startedAt = clock.wallNow();
    promptCounter += 1;
    active = {
      id: `prompt-${startedAt}-${promptCounter}`,
      startedAt,
      startedMono: clock.now(),
      requests: [],
    };
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (!active) return undefined;
    finalizeDanglingRequest();
    const sequence = active.requests.length + 1;
    active.currentRequest = {
      id: `${active.id}:${sequence}`,
      sequence,
      provider: ctx.model?.provider ?? "unknown",
      model: ctx.model?.id ?? "unknown",
      api: ctx.model?.api,
      startedAt: clock.wallNow(),
      startedMono: clock.now(),
      stallMs: 0,
      stallCount: 0,
      inStall: false,
    };
    return undefined;
  });

  pi.on("after_provider_response", (event) => {
    if (!active?.currentRequest) return;
    active.currentRequest.headersMono = clock.now();
    active.currentRequest.responseStatus = event.status;
  });

  pi.on("message_update", (event) => {
    const request = active?.currentRequest;
    if (!request) return;
    if (!isFirstContentDelta(event.assistantMessageEvent)) return;
    const now = clock.now();
    // First content delta: capture TTFT and seed the stream gap clock. The gap
    // from request start to this update is provider/network latency, not a stall.
    if (request.firstDeltaMono === undefined) {
      request.firstDeltaMono = now;
      request.lastUpdateMono = now;
      return;
    }
    // Subsequent deltas: gaps ≥ STALL_THRESHOLD_MS are inference stalls (GPU or
    // server queueing). The full gap counts as stall time; consecutive stalled
    // updates merge into one stall event, mirroring the original pi-tps.
    const gap = now - (request.lastUpdateMono ?? now);
    if (gap >= STALL_THRESHOLD_MS) {
      if (!request.inStall) request.stallCount += 1;
      request.inStall = true;
      request.stallMs += gap;
    } else {
      request.inStall = false;
    }
    request.lastUpdateMono = now;
  });

  pi.on("message_end", (event) => {
    if (!active?.currentRequest || !isAssistantMessage(event.message)) return;
    active.currentRequest.messageEndMono = clock.now();
  });

  pi.on("turn_end", (event) => {
    if (!active?.currentRequest || !isAssistantMessage(event.message)) return;
    finalizeRequest(active.currentRequest, event.message);
  });

  const settlePrompt = (ctx: ExtensionContext): void => {
    if (!active) return;
    finalizeDanglingRequest(ctx.signal?.aborted ? "aborted" : "error");
    const finished = active;
    const completedMono = clock.now();
    const completedAt = clock.wallNow();
    const prompt = aggregatePrompt(
      finished.id,
      finished.startedAt,
      completedAt,
      Math.max(0, completedMono - finished.startedMono),
      finished.requests,
    );
    for (const request of finished.requests) pi.appendEntry(REQUEST_ENTRY_TYPE, request);
    pi.appendEntry(PROMPT_ENTRY_TYPE, prompt);
    prompts.push(prompt);
    sessionProcessingMs += prompt.durationMs;
    active = undefined;
    pi.appendEntry(PROMPT_DISPLAY_MESSAGE_TYPE, {
      version: 1,
      line: promptStatus(prompt, sessionProcessingMs),
    });
  };

  pi.on("agent_end", (_event, ctx) => settlePrompt(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    settlePrompt(ctx);
  });

  pi.registerCommand("tps", {
    description: "Show completed prompt token throughput history",
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderReport(prompts), "info");
    },
  });
}

export * from "./core.js";
