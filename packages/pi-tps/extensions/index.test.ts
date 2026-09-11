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
  messageRenderers: Map<string, (...args: unknown[]) => unknown>;
  entryRenderers: Map<string, (...args: unknown[]) => unknown>;
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
    version: 3,
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
    responseMs: 1500,
    totalMs: 1600,
    stopReason: "stop",
    ...overrides,
  };
}

function prompt(overrides: Partial<PromptMetrics> = {}): PromptMetrics {
  return {
    version: 3,
    id: "prompt-1",
    startedAt: 1000,
    completedAt: 3000,
    durationMs: 2000,
    requestCount: 1,
    usage: { ...usage, cost: { ...usage.cost } },
    modelMs: 1600,
    ttftMs: 500,
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

function createHarness(options: { entryRenderer?: boolean } = {}): Harness {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const messageRendererTypes: string[] = [];
  const entryRendererTypes: string[] = [];
  const messageRenderers = new Map<string, (...args: unknown[]) => unknown>();
  const entryRenderers = new Map<string, (...args: unknown[]) => unknown>();
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
    registerMessageRenderer(customType: string, renderer: (...args: unknown[]) => unknown) {
      messageRendererTypes.push(customType);
      messageRenderers.set(customType, renderer);
    },
    ...(options.entryRenderer === false
      ? {}
      : {
          registerEntryRenderer(customType: string, renderer: (...args: unknown[]) => unknown) {
            entryRendererTypes.push(customType);
            entryRenderers.set(customType, renderer);
          },
        }),
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
  register(api as unknown as ExtensionAPI, { clock });
  return {
    handlers,
    commands,
    messageRendererTypes,
    entryRendererTypes,
    messageRenderers,
    entryRenderers,
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
  options: { ttftMs: number; responseMs: number; totalMs: number; message?: AssistantMessage },
): Promise<void> {
  const message = options.message ?? assistant();
  await emit(harness, "before_provider_request", { payload: {} });
  await emit(harness, "message_start", { message });
  const headersMs = Math.min(100, options.ttftMs);
  harness.advance(headersMs);
  await emit(harness, "after_provider_response", { status: 200, headers: {} });
  harness.advance(options.ttftMs - headersMs);
  await emit(harness, "message_update", {
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
  });
  harness.advance(options.responseMs - options.ttftMs);
  await emit(harness, "message_end", { message });
  harness.advance(options.totalMs - options.responseMs);
  await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
}

describe("metric aggregation", () => {
  test("uses one prompt-wide effective TPS formula", () => {
    const metrics = aggregatePrompt("prompt-1", 1000, 7000, 6000, [
      request(),
      request({ id: "prompt-1:2", sequence: 2, totalMs: 3500 }),
    ]);

    assert.equal(metrics.usage.output, 200);
    assert.equal(metrics.modelMs, 5100);
    assert.ok(Math.abs((rate(metrics.usage.output, metrics.durationMs) ?? 0) - 33.333) < 0.01);
  });

  test("weights session throughput by total processing time and aggregates every request TTFT", () => {
    const prompts = [
      prompt(),
      prompt({ id: "prompt-2", durationMs: 1000, requestCount: 2 }),
    ];
    const metrics = aggregateSession(prompts, [
      request(),
      request({ id: "prompt-2:1", promptId: "prompt-2", ttftMs: 100 }),
      request({ id: "prompt-2:2", promptId: "prompt-2", ttftMs: 900 }),
    ]);

    assert.equal(metrics.processingMs, 3000);
    assert.equal(metrics.requestCount, 3);
    assert.ok(Math.abs((metrics.effectiveTps ?? 0) - 66.666) < 0.01);
    assert.equal(metrics.ttftP50Ms, 500);
    assert.equal(metrics.ttftP95Ms, 900);
    assert.equal(metrics.ttftSamples, 3);
  });

  test("does not depend on stream chunk timing", () => {
    const sparse = aggregatePrompt("prompt-1", 1000, 3000, 2000, [request({ responseMs: 1900 })]);
    const burst = aggregatePrompt("prompt-1", 1000, 3000, 2000, [request({ responseMs: 100 })]);

    assert.equal(rate(sparse.usage.output, sparse.durationMs), 50);
    assert.equal(rate(burst.usage.output, burst.durationMs), 50);
  });

  test("returns n/a rates for empty output and zero duration", () => {
    assert.equal(rate(0, 1000), null);
    assert.equal(rate(100, 0), null);
  });

  test("formats durations and token counts", () => {
    assert.equal(formatDuration(73_000), "1m13s");
    assert.equal(formatTokens(18_500), "18.5K");
  });
});

describe("extension lifecycle", () => {
  test("renders persisted metrics with the muted text color", () => {
    const harness = createHarness();
    const colors: string[] = [];
    const theme = {
      fg(color: string, text: string) {
        colors.push(color);
        return text;
      },
    };
    const details = { version: 1, line: "2.0s · 50.0 tok/s" };

    harness.messageRenderers.get(PROMPT_DISPLAY_MESSAGE_TYPE)?.({ details }, {}, theme);
    harness.entryRenderers.get(PROMPT_DISPLAY_MESSAGE_TYPE)?.({ data: details }, {}, theme);

    assert.deepEqual(colors, ["muted", "muted"]);
  });

  test("falls back to a notification when the host lacks entry renderers", async () => {
    const harness = createHarness({ entryRenderer: false });
    await emit(harness, "before_agent_start", { prompt: "hello", systemPrompt: "" });
    await completeRequest(harness, { ttftMs: 500, responseMs: 1500, totalMs: 1600 });
    harness.advance(400);
    await emit(harness, "agent_settled", {});

    assert.deepEqual(harness.entries.map((entry) => entry.customType), [REQUEST_ENTRY_TYPE, PROMPT_ENTRY_TYPE]);
    assert.equal(
      harness.notifications[0],
      "2.0s · 50.0 tok/s · 1 request · TTFT 500ms · in 100 · out 100",
    );
  });

  test("persists v3 observed request and prompt metrics", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "hello", systemPrompt: "" });
    await completeRequest(harness, { ttftMs: 500, responseMs: 1500, totalMs: 1600 });
    harness.advance(400);
    await emit(harness, "agent_settled", {});

    assert.deepEqual(harness.entries.map((entry) => entry.customType), [
      REQUEST_ENTRY_TYPE,
      PROMPT_ENTRY_TYPE,
      PROMPT_DISPLAY_MESSAGE_TYPE,
    ]);
    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    const recordedPrompt = harness.entries[1]!.data as PromptMetrics;
    assert.equal(recordedRequest.version, 3);
    assert.equal(recordedRequest.ttftMs, 500);
    assert.equal(recordedRequest.responseMs, 1500);
    assert.equal(recordedRequest.totalMs, 1600);
    assert.equal(recordedRequest.usage.reasoning, 25);
    assert.equal(recordedPrompt.version, 3);
    assert.equal(recordedPrompt.durationMs, 2000);
    assert.equal(recordedPrompt.requestCount, 1);
    assert.equal(rate(recordedPrompt.usage.output, recordedPrompt.durationMs), 50);
  });

  test("includes prefill, provider latency, and tool time in the single effective TPS", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "use tools", systemPrompt: "" });
    await completeRequest(harness, { ttftMs: 800, responseMs: 1000, totalMs: 1200 });
    harness.advance(1600);
    await completeRequest(harness, { ttftMs: 500, responseMs: 1000, totalMs: 1200 });
    await emit(harness, "agent_settled", {});

    const recorded = harness.entries.find((entry) => entry.customType === PROMPT_ENTRY_TYPE)?.data as PromptMetrics;
    assert.equal(recorded.durationMs, 4000);
    assert.equal(recorded.requestCount, 2);
    assert.equal(recorded.usage.output, 200);
    assert.equal(rate(recorded.usage.output, recorded.durationMs), 50);
    assert.equal(
      (harness.entries.at(-1)?.data as { line?: string }).line,
      "4.0s · 50.0 tok/s · 2 requests · TTFT 800ms · in 200 · out 200",
    );
  });

  test("uses message_end for Pi response timing", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "pi", systemPrompt: "" });
    await completeRequest(harness, { ttftMs: 500, responseMs: 1500, totalMs: 1800 });
    await emit(harness, "agent_settled", {});

    const recorded = harness.entries[0]!.data as RequestMetrics;
    assert.equal(recorded.responseMs, 1500);
    assert.equal(recorded.totalMs, 1800);
  });

  test("uses turn_end when OMP omits message_end", async () => {
    const harness = createHarness();
    const message = assistant({ usage: { ...usage, output: 11, cost: { ...usage.cost } } });
    await emit(harness, "before_agent_start", { prompt: "omp", systemPrompt: "" });
    await emit(harness, "before_provider_request", { payload: {} });
    await emit(harness, "message_start", { message });
    harness.advance(3900);
    await emit(harness, "message_update", {
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
    });
    harness.advance(8500);
    await emit(harness, "turn_end", { turnIndex: 0, message, toolResults: [] });
    harness.advance(100);
    await emit(harness, "agent_settled", {});

    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    const recordedPrompt = harness.entries[1]!.data as PromptMetrics;
    assert.equal(recordedRequest.ttftMs, 3900);
    assert.equal(recordedRequest.responseMs, 12_400);
    assert.equal(recordedRequest.totalMs, 12_400);
    assert.equal(recordedPrompt.durationMs, 12_500);
    assert.ok(Math.abs((rate(recordedPrompt.usage.output, recordedPrompt.durationMs) ?? 0) - 0.88) < 0.001);
  });

  test("does not persist twice when both completion events fire", async () => {
    const harness = createHarness();
    await emit(harness, "before_agent_start", { prompt: "hello", systemPrompt: "" });
    await completeRequest(harness, { ttftMs: 200, responseMs: 400, totalMs: 700 });
    harness.advance(100);
    await emit(harness, "agent_end", { messages: [] });
    await emit(harness, "agent_settled", {});

    assert.equal(harness.entries.length, 3);
    assert.equal((harness.entries[1]!.data as PromptMetrics).durationMs, 800);
  });

  test("records an error with no output and reports n/a throughput", async () => {
    const harness = createHarness();
    const failed = assistant({
      content: [],
      usage: { ...emptyUsage(), cost: { ...emptyUsage().cost } },
      stopReason: "error",
      errorMessage: "stream failed",
    });
    await emit(harness, "before_agent_start", { prompt: "fail", systemPrompt: "" });
    await emit(harness, "before_provider_request", { payload: {} });
    harness.advance(300);
    await emit(harness, "message_end", { message: failed });
    await emit(harness, "turn_end", { turnIndex: 0, message: failed, toolResults: [] });
    await emit(harness, "agent_settled", {});

    const recordedRequest = harness.entries[0]!.data as RequestMetrics;
    const recordedPrompt = harness.entries[1]!.data as PromptMetrics;
    assert.equal(recordedRequest.ttftMs, null);
    assert.equal(recordedRequest.stopReason, "error");
    assert.equal(recordedPrompt.status, "error");
    assert.match((harness.entries[2]!.data as { line?: string }).line ?? "", / · n\/a tok\/s · /);
  });

  test("restores v1 and v2 records as v3 observed metrics", () => {
    const legacyRequest = {
      ...request(),
      version: 2,
      generationMs: 1500,
      stallMs: 600,
      stallCount: 1,
      outputTps: 100,
    };
    delete (legacyRequest as { responseMs?: number | null }).responseMs;
    const legacyPrompt = {
      ...prompt(),
      version: 1,
      generationMs: 1000,
      stallMs: 600,
      stallCount: 1,
      activeTps: 100,
      effectiveTps: 50,
    };
    const sessionManager = {
      getBranch: () => [
        { type: "custom", customType: "pi-tps/request/v2", data: legacyRequest },
        { type: "custom", customType: "pi-tps/prompt/v1", data: legacyPrompt },
        { type: "custom", customType: REQUEST_ENTRY_TYPE, data: request({ id: "prompt-2:1" }) },
      ],
    };

    const restored = restoreMetrics(sessionManager);
    assert.equal(restored.requests.length, 2);
    assert.equal(restored.requests[0]!.version, 3);
    assert.equal(restored.requests[0]!.responseMs, 1500);
    assert.equal(restored.prompts.length, 1);
    assert.equal(restored.prompts[0]!.version, 3);
  });

  test("restores only the active branch and reports prompt plus session summaries", async () => {
    const harness = createHarness();
    harness.branch.push(
      { type: "custom", customType: REQUEST_ENTRY_TYPE, data: request() },
      { type: "custom", customType: PROMPT_ENTRY_TYPE, data: prompt() },
      { type: "custom", customType: PROMPT_ENTRY_TYPE, data: { version: 99 } },
    );
    await emit(harness, "session_tree", { newLeafId: "leaf", oldLeafId: "old" });
    await harness.commands.get("tps")?.("", harness.context);

    const lines = (harness.notifications.at(-1) ?? "").split("\n");
    assert.deepEqual(lines, [
      "2.0s · 50.0 tok/s · 1 request · TTFT 500ms · in 100 · out 100",
      "1 prompt · 1 request · 50.0 tok/s · processing 2.0s",
      "TTFT p50 500ms · p95 500ms · n=1",
    ]);
  });

  test("keeps one line per prompt and uses processing time instead of idle wall time", () => {
    const prompts = [
      prompt(),
      prompt({ id: "prompt-2", startedAt: 103_000, completedAt: 104_000, durationMs: 1000 }),
    ];
    const text = renderReport(prompts, [request(), request({ id: "prompt-2:1", promptId: "prompt-2" })]);
    const lines = text.split("\n");

    assert.equal(lines.length, 4);
    assert.equal(lines[2], "2 prompts · 2 requests · 66.7 tok/s · processing 3.0s");
    assert.equal(lines[3], "TTFT p50 500ms · p95 500ms · n=2");
  });
});
