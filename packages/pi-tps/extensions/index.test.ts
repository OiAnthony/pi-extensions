import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register, {
  PROMPT_DISPLAY_MESSAGE_TYPE,
  PROMPT_ENTRY_TYPE,
  REQUEST_ENTRY_TYPE,
  aggregatePrompt,
  aggregateSession,
  emptyUsage,
  formatDuration,
  formatTokens,
  rate,
  rateAfterStall,
  renderReport,
  restoreMetrics,
  type Clock,
  type PromptMetrics,
  type RequestMetrics,
} from "./index.js";

type BranchEntry = { type: string; customType?: string; data?: unknown };

interface HarnessContext {
  mode: string;
  model: { provider: string; id: string; api: string };
  signal: AbortSignal | undefined;
  sessionManager: { getBranch(): BranchEntry[] };
  ui: {
    setStatus(key: string, value: string | undefined): void;
    setWidget(key: string, value: string[] | undefined): void;
    notify(value: string): void;
  };
}

type Handler = (event: Record<string, unknown>, context: HarnessContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, context: HarnessContext) => Promise<void> | void;
type SentMessage = { customType: string; content: string; display: boolean; details?: unknown };

interface Harness {
  handlers: Map<string, Handler>;
  commands: Map<string, CommandHandler>;
  messageRendererTypes: string[];
  entryRendererTypes: string[];
  sentMessages: SentMessage[];
  entries: Array<{ customType: string; data: unknown }>;
  notifications: string[];
  widgets: Array<string[] | undefined>;
  branch: BranchEntry[];
  context: HarnessContext;
  advance(milliseconds: number): void;
}

const usage: Usage = {
  input: 100,
  output: 100,
  cacheRead: 40,
  cacheWrite: 10,
  reasoning: 25,
  totalTokens: 250,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};

function request(overrides: Partial<RequestMetrics> = {}): RequestMetrics {
  return {
    version: 1,
    id: "prompt-1:1",
    promptId: "prompt-1",
    sequence: 1,
    provider: "test",
    model: "model",
    api: "test-api",
    startedAt: 1000,
    completedAt: 2600,
    responseStatus: 200,
    usage: { ...usage, cost: { ...usage.cost } },
    headersMs: 100,
    ttftMs: 500,
    generationMs: 1000,
    stallMs: 0,
    stallCount: 0,
    totalMs: 1600,
    outputTps: 100,
    stopReason: "stop",
    ...overrides,
  };
}

function prompt(overrides: Partial<PromptMetrics> = {}): PromptMetrics {
  return {
    version: 1,
    id: "prompt-1",
    startedAt: 1000,
    completedAt: 3000,
    durationMs: 2000,
    requestCount: 1,
    usage: { ...usage, cost: { ...usage.cost } },
    modelMs: 1600,
    generationMs: 1000,
    stallMs: 0,
    stallCount: 0,
    ttftMs: 500,
    activeTps: 100,
    effectiveTps: 50,
    status: "completed",
    ...overrides,
  };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "test-api",
    provider: "test",
    model: "model",
    usage: { ...usage, cost: { ...usage.cost } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function createHarness(): Harness {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const messageRendererTypes: string[] = [];
  const entryRendererTypes: string[] = [];
  const sentMessages: SentMessage[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  const branch: BranchEntry[] = [];
  let mono = 0;
  let wall = 1_000_000;
  const clock: Clock = {
    now: () => mono,
    wallNow: () => wall,
  };
  const advance = (milliseconds: number): void => {
    mono += milliseconds;
    wall += milliseconds;
  };
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    registerMessageRenderer(customType: string) {
      messageRendererTypes.push(customType);
    },
    registerEntryRenderer(customType: string) {
      entryRendererTypes.push(customType);
    },
    sendMessage(message: SentMessage) {
      sentMessages.push(message);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
      branch.push({ type: "custom", customType, data });
    },
  };
  const context: HarnessContext = {
    mode: "tui",
    model: { provider: "test", id: "model", api: "test-api" },
    signal: undefined,
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus() {},
      setWidget(_key: string, value: string[] | undefined) {
        widgets.push(value);
      },
      notify(value: string) {
        notifications.push(value);
      },
    },
  };
  // The harness implements only the ExtensionAPI surface exercised by this extension.
  const extensionApi = api as unknown as ExtensionAPI;
  register(extensionApi, { clock });
  return {
    handlers,
    commands,
    messageRendererTypes,
    entryRendererTypes,
    sentMessages,
    entries,
    notifications,
    widgets,
    branch,
    context,
    advance,
  };
}

async function emit(harness: Harness, name: string, event: Record<string, unknown>): Promise<void> {
  await harness.handlers.get(name)?.({ type: name, ...event }, harness.context);
}

async function completeRequest(
  harness: Harness,
  options: { ttftMs: number; generationMs: number; totalMs: number; message?: AssistantMessage },
): Promise<void> {
  await emit(harness, "before_provider_request", { payload: {} });
  harness.advance(100);
  await emit(harness, "after_provider_response", { status: 200, headers: {} });
  harness.advance(options.ttftMs - 100);
  await emit(harness, "message_update", {
    message: options.message ?? assistant(),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: options.message ?? assistant() },
  });
  harness.advance(options.generationMs);
  await emit(harness, "message_end", { message: options.message ?? assistant() });
  harness.advance(options.totalMs - options.ttftMs - options.generationMs);
  await emit(harness, "turn_end", { turnIndex: 0, message: options.message ?? assistant(), toolResults: [] });
}

describe("metric aggregation", () => {
  test("uses weighted generation time instead of averaging request rates", () => {
    const requests = [
      request(),
      request({ id: "prompt-1:2", sequence: 2, generationMs: 3000, totalMs: 3500, outputTps: 100 / 3 }),
    ];
    const metrics = aggregatePrompt("prompt-1", 1000, 7000, 6000, requests);

    assert.equal(metrics.usage.output, 200);
    assert.equal(metrics.generationMs, 4000);
    assert.equal(metrics.activeTps, 50);
    assert.ok(Math.abs((metrics.effectiveTps ?? 0) - 33.333) < 0.01);
  });

  test("excludes user idle gaps from session processing time and effective TPS", () => {
    const prompts = [
      prompt(),
      prompt({ id: "prompt-2", startedAt: 103_000, completedAt: 104_000, durationMs: 1000 }),
    ];
    const metrics = aggregateSession(prompts, [request(), request({ id: "prompt-2:1", promptId: "prompt-2" })]);

    assert.equal(metrics.processingMs, 3000);
    assert.equal(metrics.usage.output, 200);
    assert.ok(Math.abs((metrics.effectiveTps ?? 0) - 66.666) < 0.01);
    assert.notEqual(metrics.processingMs, prompts[1]!.completedAt - prompts[0]!.startedAt);
  });

  test("returns n/a rates for empty output and zero generation duration", () => {
    assert.equal(rate(0, 1000), null);
    assert.equal(rate(100, 0), null);
  });

  test("formats minute durations without spaces", () => {
    assert.equal(formatDuration(73_000), "1m13s");
  });

  test("formats thousands like the original pi-tps line", () => {
    assert.equal(formatTokens(18_500), "18.5K");
  });

  test("aggregates stall time and count across requests", () => {
    const requests = [
      request({ stallMs: 600, stallCount: 1 }),
      request({ id: "prompt-1:2", sequence: 2, stallMs: 1400, stallCount: 2 }),
    ];
    const metrics = aggregatePrompt("prompt-1", 1000, 7000, 6000, requests);

    assert.equal(metrics.stallMs, 2000);
    assert.equal(metrics.stallCount, 3);
  });

  test("subtracts stall time from generation time for active TPS", () => {
    const requests = [request({ generationMs: 4000, stallMs: 1000, stallCount: 1 })];
    const metrics = aggregatePrompt("prompt-1", 1000, 7000, 6000, requests);

    assert.equal(metrics.generationMs, 4000);
    assert.equal(metrics.stallMs, 1000);
    assert.equal(metrics.activeTps, 100 / 3);
  });

  test("rejects implausible rates above 10k tok/s", () => {
    assert.equal(rateAfterStall(5000, 300, 0), null);
    assert.equal(rateAfterStall(100, 1000, 600), 250);
    assert.equal(rateAfterStall(100, 1000, 0), 100);
  });

  test("partially discounts stalls when they dominate the generation window", () => {
    // stall 1400ms of a 1000ms window — dominated; half the stall is discounted
    const tps = rateAfterStall(100, 1000, 1400);
    assert.ok(tps !== null && Math.abs(tps - 100 / 0.3) < 0.01);
  });
});

describe("extension lifecycle", () => {
  test("records exact request usage, TTFT, prompt duration, and persisted entries", async () => {
    const harness = createHarness();
    await emit(harness, "session_start", { reason: "startup" });
    await emit(harness, "before_agent_start", { prompt: "hello", systemPrompt: "", systemPromptOptions: {} });
    harness.advance(5);
    await completeRequest(harness, { ttftMs: 500, generationMs: 1000, totalMs: 1600 });
    harness.advance(395);
    await emit(harness, "agent_settled", {});

    assert.equal(harness.entries.length, 3);
    assert.equal(harness.entries[0]!.customType, REQUEST_ENTRY_TYPE);
    assert.equal(harness.entries[1]!.customType, PROMPT_ENTRY_TYPE);
    assert.equal(harness.entries[2]!.customType, PROMPT_DISPLAY_MESSAGE_TYPE);
    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    const recordedPrompt = harness.entries[1]!.data as PromptMetrics;
    assert.equal(recordedRequest.ttftMs, 500);
    assert.equal(recordedRequest.generationMs, 1000);
    assert.equal(recordedRequest.totalMs, 1600);
    assert.equal(recordedRequest.outputTps, 100);
    assert.equal(recordedRequest.usage.reasoning, 25);
    assert.equal(recordedPrompt.durationMs, 2000);
    assert.equal(recordedPrompt.effectiveTps, 50);
    assert.equal(harness.notifications.length, 0);
    assert.deepEqual(harness.messageRendererTypes, [PROMPT_DISPLAY_MESSAGE_TYPE]);
    assert.deepEqual(harness.entryRendererTypes, [PROMPT_DISPLAY_MESSAGE_TYPE]);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.widgets.length, 0);
    const displayData = harness.entries[2]!.data as { line?: string };
    assert.match(
      displayData.line ?? "",
      /^TPS 100\.0 tok\/s · TTFT 500ms · in 100 · out 100 · 2\.0s$/,
    );
  });

  test("starts TTFT and generation timing at the first content delta", async () => {
    const harness = createHarness();
    const message = assistant();
    await emit(harness, "before_agent_start", { prompt: "hello", systemPrompt: "", systemPromptOptions: {} });
    await emit(harness, "before_provider_request", { payload: {} });
    harness.advance(100);
    await emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
    });
    harness.advance(400);
    await emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
    });
    harness.advance(1000);
    await emit(harness, "message_end", { message });
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
    await emit(harness, "agent_settled", {});

    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    assert.equal(recordedRequest.ttftMs, 500);
    assert.equal(recordedRequest.generationMs, 1000);
  });

  test("uses agent_end as a prompt completion boundary without double persistence", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "hello", systemPrompt: "", systemPromptOptions: {} });
    await completeRequest(harness, { ttftMs: 200, generationMs: 400, totalMs: 700 });
    harness.advance(100);
    await emit(harness, "agent_end", { messages: [] });
    await emit(harness, "agent_settled", {});

    assert.equal(harness.entries.length, 3);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal((harness.entries[1]!.data as PromptMetrics).durationMs, 800);
  });

  test("detects a single inference stall from stream gaps and nets it out of TPS", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "stall", systemPrompt: "", systemPromptOptions: {} });
    await emit(harness, "before_provider_request", { payload: {} });
    harness.advance(100);
    await emit(harness, "after_provider_response", { status: 200, headers: {} });
    harness.advance(400);
    const message = assistant();
    await emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: message },
    });
    harness.advance(600); // gap ≥ 500ms → stall
    await emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial: message },
    });
    harness.advance(200);
    await emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "c", partial: message },
    });
    harness.advance(200);
    await emit(harness, "message_end", { message });
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
    await emit(harness, "agent_settled", {});

    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    assert.equal(recordedRequest.stallMs, 600);
    assert.equal(recordedRequest.stallCount, 1);
    assert.equal(recordedRequest.generationMs, 1000); // 600 + 200 + 200
    assert.equal(recordedRequest.outputTps, 250); // 100 tok / 0.4s net of stall
    const recordedPrompt = harness.entries[1]!.data as PromptMetrics;
    assert.equal(recordedPrompt.stallMs, 600);
    const line = (harness.entries[2]!.data as { line?: string }).line ?? "";
    assert.match(line, /^TPS 250\.0 tok\/s/);
    assert.match(line, /· stall 600ms×1 · 1\.5s$/);
  });

  test("merges consecutive stalled updates into one stall event and discounts dominance", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "stall chain", systemPrompt: "", systemPromptOptions: {} });
    await emit(harness, "before_provider_request", { payload: {} });
    harness.advance(100);
    await emit(harness, "after_provider_response", { status: 200, headers: {} });
    harness.advance(400);
    const message = assistant();
    const update = (delta: string): Promise<void> => emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
    });
    await update("a");
    harness.advance(600); // stall 1
    await update("b");
    harness.advance(800); // stall 2, consecutive → still one event
    await update("c");
    harness.advance(200); // resume streaming
    await update("d");
    await emit(harness, "message_end", { message });
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
    await emit(harness, "agent_settled", {});

    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    assert.equal(recordedRequest.stallMs, 1400);
    assert.equal(recordedRequest.stallCount, 1);
    // generationMs = 1600 (first delta → message end); stall 1400 > 85% of 1600
    // → dominated branch, half discounted: 100 tok / (1600 - 1400/2)ms
    assert.ok(Math.abs((recordedRequest.outputTps ?? 0) - 100 / 0.9) < 0.01);
    const line = (harness.entries[2]!.data as { line?: string }).line ?? "";
    assert.match(line, /· stall 1\.4s×1 /);
  });

  test("aggregates multiple requests under one prompt", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "use tools", systemPrompt: "", systemPromptOptions: {} });
    await completeRequest(harness, { ttftMs: 200, generationMs: 1000, totalMs: 1300 });
    harness.advance(200);
    await completeRequest(harness, { ttftMs: 300, generationMs: 3000, totalMs: 3500 });
    await emit(harness, "agent_settled", {});

    const promptEntry = harness.entries.find((entry) => entry.customType === PROMPT_ENTRY_TYPE);
    assert.ok(promptEntry);
    const recordedPrompt = promptEntry.data as PromptMetrics;
    assert.equal(recordedPrompt.requestCount, 2);
    assert.equal(recordedPrompt.usage.output, 200);
    assert.equal(recordedPrompt.activeTps, 50);
    assert.match(
      (harness.entries.find((entry) => entry.customType === PROMPT_DISPLAY_MESSAGE_TYPE)?.data as { line?: string } | undefined)?.line ?? "",
      /^TPS 50\.0 tok\/s · TTFT 200ms · in 200 · out 200 · 5\.0s$/,
    );
  });

  test("keeps TTFT and TPS unavailable when the stream fails before content", async () => {
    const harness = createHarness();
    const failed = assistant({
      content: [],
      usage: { ...emptyUsage(), cost: { ...emptyUsage().cost } },
      stopReason: "error",
      errorMessage: "stream failed",
    });
    await emit(harness, "before_agent_start", { prompt: "fail", systemPrompt: "", systemPromptOptions: {} });
    await emit(harness, "before_provider_request", { payload: {} });
    harness.advance(300);
    await emit(harness, "message_end", { message: failed });
    await emit(harness, "turn_end", { turnIndex: 0, message: failed, toolResults: [] });
    await emit(harness, "agent_settled", {});

    const recorded = harness.entries[0]!.data as RequestMetrics;
    assert.equal(recorded.ttftMs, null);
    assert.equal(recorded.outputTps, null);
    assert.equal(recorded.stopReason, "error");
  });

  test("restores only metrics on the active branch after tree navigation", async () => {
    const harness = createHarness();
    harness.branch.push(
      { type: "custom", customType: REQUEST_ENTRY_TYPE, data: request() },
      { type: "custom", customType: PROMPT_ENTRY_TYPE, data: prompt() },
      { type: "custom", customType: PROMPT_ENTRY_TYPE, data: { version: 99 } },
    );
    await emit(harness, "session_tree", { newLeafId: "leaf", oldLeafId: "old" });
    await harness.commands.get("tps")?.("", harness.context);

    const restored = restoreMetrics(harness.context.sessionManager);
    assert.equal(restored.requests.length, 1);
    assert.equal(restored.prompts.length, 1);
    const lines = (harness.notifications.at(-1) ?? "").split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^TPS 100\.0 tok\/s · TTFT 500ms/);
    assert.match(lines[0] ?? "", /· in 100 · out 100/);
    assert.match(lines[0] ?? "", /· 2\.0s$/);
    assert.doesNotMatch(lines.join(""), /session/i);
    assert.doesNotMatch(lines.join(""), /(?:TPS|TTFT|Req|Reasoning|Time|Session):/);
    assert.doesNotMatch(lines.join(""), /Eff:|Cache:|\$/);
  });

  test("reports session processing time without idle wall-clock gaps", () => {
    const text = renderReport([
      prompt(),
      prompt({ id: "prompt-2", startedAt: 103_000, completedAt: 104_000, durationMs: 1000 }),
    ]);
    const promptLines = text.split("\n");
    assert.match(promptLines[0] ?? "", /· in 100 · out 100 · 2\.0s$/);
    assert.match(promptLines[1] ?? "", /· in 100 · out 100 · 3\.0s\(\+1\.0s\)$/);
  });

  test("keeps one line for every completed prompt in session order", () => {
    const text = renderReport([
      prompt(),
      prompt({ id: "prompt-2", startedAt: 4000, completedAt: 5000, durationMs: 1000 }),
    ]);

    const lines = text.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /^TPS 100\.0 tok\/s/);
    assert.match(lines[1] ?? "", /^TPS 100\.0 tok\/s/);
    assert.doesNotMatch(text, /\bP[12] |TPS:/);
  });
});
