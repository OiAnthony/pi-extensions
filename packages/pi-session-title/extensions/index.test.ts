import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register, {
  MAX_CONTEXT_LENGTH,
  STATE_ENTRY_TYPE,
  buildNamingContext,
  cleanTitle,
  createHerdrCliArgs,
  createHerdrReporter,
  createState,
  extractCompletedExchanges,
  extractRecentMessages,
  nextAutomaticEvaluation,
  normalizeConfig,
  parseModelReference,
  renderTerminalTitle,
  requestTitle,
  restoreState,
  trimRecentContext,
  type HerdrRequest,
  type SessionTitleConfig,
  type TitleCompletionContext,
  type TitleDependencies,
} from "./index.js";

type RegisteredHandler = (event: any, context: any) => Promise<void> | void;
type Model = NonNullable<TitleCompletionContext["model"]>;
type CompletionResult = Awaited<ReturnType<TitleDependencies["complete"]>>;

const currentModel = { provider: "test", id: "current" } as Model;
const configuredModel = { provider: "openrouter", id: "vendor/model" } as Model;

function response(text: string): CompletionResult {
  return { content: [{ type: "text", text }], stopReason: "stop" } as CompletionResult;
}

function message(role: "user" | "assistant", content: unknown): unknown {
  return { type: "message", message: { role, content } };
}

function defaultConfig(overrides: Partial<SessionTitleConfig> = {}): SessionTitleConfig {
  const base = normalizeConfig(undefined);
  return {
    ...base,
    ...overrides,
    terminalTitle: { ...base.terminalTitle, ...overrides.terminalTitle },
    herdr: { ...base.herdr, ...overrides.herdr },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met.");
}

describe("configuration and title normalization", () => {
  test("normalizes invalid fields and splits model IDs at the first slash", () => {
    assert.deepEqual(parseModelReference("openrouter/vendor/model"), {
      provider: "openrouter",
      modelId: "vendor/model",
    });
    assert.equal(parseModelReference("invalid"), undefined);

    const config = normalizeConfig({
      enabled: false,
      refreshTurns: -1,
      timeoutMs: 0,
      maxTokens: 80,
      maxLength: 30,
      thinkingLevel: "invalid",
      terminalTitle: { enabled: false, template: "{title} @ {cwd}" },
      unknown: true,
    });
    assert.equal(config.enabled, false);
    assert.equal(config.refreshTurns, 4);
    assert.equal(config.timeoutMs, 5_000);
    assert.equal(config.maxTokens, 80);
    assert.equal(config.maxLength, 30);
    assert.equal(config.thinkingLevel, "minimal");
    assert.deepEqual(config.terminalTitle, { enabled: false, template: "{title} @ {cwd}" });
  });

  test("cleans ANSI, Markdown, quotes, controls, newlines, punctuation, and code points", () => {
    assert.equal(cleanTitle("\u001b[31m**\"修复认证流程。\"**\u001b[0m\nignored", 8), "修复认证流程");
    assert.equal(cleanTitle("\u0000\n"), undefined);
    assert.equal(cleanTitle("abcdefghij", 4), "abcd");
    assert.equal(cleanTitle("😀😀😀", 2), "😀😀");
  });

  test("renders a control-free terminal title", () => {
    assert.equal(renderTerminalTitle("π {title} ({cwd})", "Auth\nfix", "/tmp/project"), "π Authfix (project)");
  });
});

describe("active branch conversation state", () => {
  const entries = [
    message("user", [{ type: "text", text: "/model" }]),
    message("user", [{ type: "image", data: "x" }]),
    message("user", [{ type: "text", text: "Fix auth" }, { type: "image", data: "x" }]),
    message("assistant", [{ type: "thinking", thinking: "secret" }, { type: "toolCall", name: "read" }]),
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret result" }] } },
    message("assistant", [{ type: "text", text: "Updated middleware" }]),
    message("user", "Add tests"),
    message("assistant", [{ type: "text", text: "Added focused tests" }]),
  ];

  test("counts only completed valid user/assistant exchanges", () => {
    assert.deepEqual(extractCompletedExchanges(entries), [
      { user: "Fix auth", assistant: "Updated middleware" },
      { user: "Add tests", assistant: "Added focused tests" },
    ]);
  });

  test("extracts only recent visible user and assistant text", () => {
    assert.deepEqual(extractRecentMessages(entries, 3), [
      { role: "assistant", text: "Updated middleware" },
      { role: "user", text: "Add tests" },
      { role: "assistant", text: "Added focused tests" },
    ]);
  });

  test("triggers initial and periodic boundaries without repeated checks", () => {
    assert.equal(nextAutomaticEvaluation(undefined, 1, 3), "initial");
    assert.equal(nextAutomaticEvaluation(undefined, 2, 3), undefined);
    const generated = createState("generated", 1, "Auth fix");
    assert.equal(nextAutomaticEvaluation(generated, 3, 3), undefined);
    assert.equal(nextAutomaticEvaluation(generated, 4, 3), "refresh");
    assert.equal(nextAutomaticEvaluation(createState("generated", 4, "Auth fix"), 7, 3), "refresh");
    assert.equal(nextAutomaticEvaluation(createState("manual", 1, "Manual"), 10, 3), undefined);
    assert.equal(nextAutomaticEvaluation(generated, 10, 0), undefined);
  });

  test("restores the latest versioned state on the active branch", () => {
    const oldState = createState("generated", 1, "Old");
    const latest = createState("manual", 2, "Manual");
    assert.deepEqual(restoreState([
      { type: "custom", customType: STATE_ENTRY_TYPE, data: oldState },
      { type: "custom", customType: STATE_ENTRY_TYPE, data: { version: 2, status: "generated" } },
      { type: "custom", customType: STATE_ENTRY_TYPE, data: latest },
    ]), latest);
  });

  test("caps initial and refresh context with the required retention priority", () => {
    const firstBlock = buildNamingContext("initial", [
      message("user", [{ type: "text", text: "Fix auth" }]),
      message("assistant", [
        { type: "text", text: "First visible block" },
        { type: "text", text: "Second visible block" },
      ]),
    ]);
    assert.equal(firstBlock?.messages[1]?.text, "First visible block");

    const initial = buildNamingContext("initial", [
      message("user", [{ type: "text", text: "u".repeat(MAX_CONTEXT_LENGTH + 10) }]),
      message("assistant", [{ type: "text", text: "assistant" }]),
    ]);
    assert.equal(initial?.messages.length, 1);
    assert.equal(initial?.messages[0]?.text.length, MAX_CONTEXT_LENGTH);

    const recent = trimRecentContext([
      { role: "user", text: "old".repeat(2_000) },
      { role: "assistant", text: "new".repeat(1_000) },
    ]);
    assert.equal(recent.at(-1)?.text, "new".repeat(1_000));
    assert.equal(recent.reduce((sum, item) => sum + Array.from(item.text).length, 0), MAX_CONTEXT_LENGTH);
  });
});

describe("model selection and completion", () => {
  test("falls back once to the current model after configured authentication failure", async () => {
    const calls: string[] = [];
    const context: TitleCompletionContext = {
      model: currentModel,
      modelRegistry: {
        find: () => configuredModel,
        getApiKeyAndHeaders: async (model) => model === configuredModel
          ? { ok: false }
          : { ok: true, apiKey: "current-key" },
      },
    };
    const result = await requestTitle(
      { kind: "initial", messages: [{ role: "user", text: "修复认证" }] },
      context,
      defaultConfig({ model: "openrouter/vendor/model" }),
      undefined,
      { complete: async (model) => {
        calls.push(`${model.provider}/${model.id}`);
        return response("认证修复");
      } },
    );

    assert.equal(result.kind, "title");
    assert.equal(result.configuredModelFailed, true);
    assert.deepEqual(calls, ["test/current"]);
  });

  test("does not duplicate an attempt when configured and current models match", async () => {
    let calls = 0;
    const result = await requestTitle(
      { kind: "initial", messages: [{ role: "user", text: "Fix auth" }] },
      {
        model: currentModel,
        modelRegistry: {
          find: () => currentModel,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
        },
      },
      defaultConfig({ model: "test/current" }),
      undefined,
      { complete: async () => {
        calls++;
        throw new Error("provider failed");
      } },
    );
    assert.equal(result.kind, "failed");
    assert.equal(calls, 1);
  });

  test("accepts KEEP only for refresh/manual evaluations and forwards budgets", async () => {
    let options: any;
    const context: TitleCompletionContext = {
      model: currentModel,
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
      },
    };
    const result = await requestTitle(
      { kind: "refresh", currentTitle: "Auth fix", messages: [{ role: "user", text: "More auth work" }] },
      context,
      defaultConfig({ thinkingLevel: "low", maxTokens: 55 }),
      undefined,
      { complete: async (_model, _request, completionOptions) => {
        options = completionOptions;
        return response(" KEEP ");
      } },
    );
    assert.equal(result.kind, "keep");
    assert.equal(options.maxTokens, 55);
    assert.equal(options.reasoning, "low");
  });
});

describe("Herdr metadata reporting", () => {
  test("uses increasing sequence numbers and the protocol constants", async () => {
    const requests: HerdrRequest[] = [];
    const reporter = createHerdrReporter(
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      {
        now: () => 100,
        sendSocket: async (_path, request) => {
          requests.push(request);
          return true;
        },
        exec: async () => ({ code: 1 }),
      },
    );
    assert.equal(await reporter.report("Auth fix"), true);
    assert.equal(await reporter.report(undefined), true);
    assert.equal(requests[0]?.params.seq, 100_001);
    assert.equal(requests[1]?.params.seq, 100_002);
    assert.equal(requests[0]?.params.source, "user:pi-session-title");
    assert.equal(requests[0]?.params.applies_to_source, "herdr:pi");
    assert.equal(requests[1]?.params.clear_title, true);
  });

  test("retries socket then falls back to an explicit-pane CLI command", async () => {
    const timeouts: number[] = [];
    let command: string | undefined;
    let args: string[] | undefined;
    const reporter = createHerdrReporter(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p9",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_BIN_PATH: "/opt/herdr",
      },
      {
        now: () => 1,
        sendSocket: async (_path, _request, timeout) => {
          timeouts.push(timeout);
          return false;
        },
        exec: async (receivedCommand, receivedArgs) => {
          command = receivedCommand;
          args = receivedArgs;
          return { code: 0 };
        },
      },
    );
    assert.equal(await reporter.report("Auth fix"), true);
    assert.deepEqual(timeouts, [500, 1_500]);
    assert.equal(command, "/opt/herdr");
    assert.deepEqual(args, createHerdrCliArgs("w1:p9", "Auth fix", 1_001));
    assert.equal(args?.includes("rename"), false);
  });
});

describe("extension lifecycle and race protection", () => {
  function createHarness(
    completeTitle: TitleDependencies["complete"],
    configOverrides: Partial<SessionTitleConfig> = {},
  ) {
    const handlers = new Map<string, RegisteredHandler>();
    let commandHandler: ((args: string, context: any) => Promise<void> | void) | undefined;
    let confirmCalls = 0;
    let name: string | undefined;
    let file = "/tmp/session-a.jsonl";
    const entries: any[] = [
      message("user", [{ type: "text", text: "Fix auth" }]),
      message("assistant", [{ type: "text", text: "Updated middleware" }]),
    ];
    const titles: string[] = [];
    const notifications: string[] = [];
    const appended: any[] = [];
    const context = {
      mode: "tui",
      cwd: "/tmp/project",
      model: currentModel,
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
      },
      sessionManager: {
        getBranch: () => entries,
        getSessionFile: () => file,
        getSessionName: () => name,
      },
      ui: {
        setTitle: (title: string) => titles.push(title),
        notify: (text: string) => notifications.push(text),
        confirm: async () => {
          confirmCalls++;
          return true;
        },
      },
      waitForIdle: async () => {},
    };
    const pi = {
      on: (event: string, handler: RegisteredHandler) => handlers.set(event, handler),
      registerCommand: (_name: string, options: { handler: (args: string, context: any) => Promise<void> | void }) => {
        commandHandler = options.handler;
      },
      getSessionName: () => name,
      setSessionName: (next: string) => { name = next; },
      appendEntry: (customType: string, data: unknown) => {
        const entry = { type: "custom", customType, data };
        entries.push(entry);
        appended.push(entry);
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI;

    register(
      pi,
      defaultConfig({ ...configOverrides, herdr: { enabled: false } }),
      { title: { complete: completeTitle } },
    );
    return {
      handlers,
      context,
      entries,
      titles,
      notifications,
      appended,
      command: (args: string) => commandHandler?.(args, context),
      getConfirmCalls: () => confirmCalls,
      getName: () => name,
      setName: (next: string | undefined) => { name = next; },
      setFile: (next: string) => { file = next; },
    };
  }

  test("generates once after the first settled exchange and persists state", async () => {
    let calls = 0;
    const harness = createHarness(async () => {
      calls++;
      return response("Auth middleware fix");
    });
    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
    harness.handlers.get("agent_settled")?.({}, harness.context);
    await waitFor(() => harness.getName() === "Auth middleware fix");

    assert.equal(calls, 1);
    assert.equal(harness.titles.at(-1), "π Auth middleware fix (project)");
    assert.equal(harness.appended.at(-1)?.data.status, "generated");
    assert.equal(harness.appended.at(-1)?.data.lastEvaluatedUserTurnCount, 1);

    harness.handlers.get("agent_settled")?.({}, harness.context);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
  });

  test("manual naming during a request wins and creates a persistent lock", async () => {
    let resolveCompletion: ((result: CompletionResult) => void) | undefined;
    const harness = createHarness(async () => new Promise<CompletionResult>((resolve) => {
      resolveCompletion = resolve;
    }));
    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
    harness.handlers.get("agent_settled")?.({}, harness.context);
    await waitFor(() => Boolean(resolveCompletion));

    harness.setName("manual-title");
    await harness.handlers.get("session_info_changed")?.({ name: "manual-title" }, harness.context);
    resolveCompletion?.(response("Generated title"));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    assert.equal(harness.getName(), "manual-title");
    assert.equal(harness.appended.at(-1)?.data.status, "manual");
    harness.handlers.get("agent_settled")?.({}, harness.context);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(harness.getName(), "manual-title");
  });

  test("the manual command confirms before taking ownership of a manual name", async () => {
    const harness = createHarness(async () => response("Generated replacement"));
    harness.setName("manual-title");
    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
    await harness.command("");

    assert.equal(harness.getConfirmCalls(), 1);
    assert.equal(harness.getName(), "Generated replacement");
    assert.equal(harness.appended.at(-1)?.data.status, "generated");
    assert.deepEqual(harness.notifications.slice(-2), [
      "Generating session title...",
      "Session title updated: Generated replacement",
    ]);
  });

  test("the manual command reports when the current title remains accurate", async () => {
    let calls = 0;
    const harness = createHarness(async () => response(calls++ === 0 ? "Auth fix" : "KEEP"));
    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
    await harness.command("");
    await harness.command("");

    assert.deepEqual(harness.notifications.slice(-2), [
      "Generating session title...",
      "Session title is already up to date.",
    ]);
  });

  test("the manual command reports when no conversation is available", async () => {
    const harness = createHarness(async () => response("Unexpected title"));
    harness.entries.splice(0, harness.entries.length);
    await harness.command("");

    assert.equal(harness.getName(), undefined);
    assert.deepEqual(harness.notifications, ["No conversation is available to generate a session title."]);
  });

  test("the disabled manual command preserves title ownership", async () => {
    let calls = 0;
    const harness = createHarness(async () => {
      calls++;
      return response("Unexpected title");
    }, { enabled: false });
    harness.setName("manual-title");
    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
    const entriesBefore = harness.appended.length;
    await harness.command("");

    assert.equal(calls, 0);
    assert.equal(harness.getName(), "manual-title");
    assert.equal(harness.appended.length, entriesBefore);
  });

  test("a request from a replaced session cannot rename the new session", async () => {
    let resolveCompletion: ((result: CompletionResult) => void) | undefined;
    const harness = createHarness(async () => new Promise<CompletionResult>((resolve) => {
      resolveCompletion = resolve;
    }));
    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.context);
    harness.handlers.get("agent_settled")?.({}, harness.context);
    await waitFor(() => Boolean(resolveCompletion));

    await harness.handlers.get("session_shutdown")?.({ reason: "resume" }, harness.context);
    harness.setFile("/tmp/session-b.jsonl");
    harness.setName(undefined);
    harness.entries.splice(0, harness.entries.length);
    await harness.handlers.get("session_start")?.({ reason: "resume" }, harness.context);
    resolveCompletion?.(response("Old session title"));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    assert.equal(harness.getName(), undefined);
  });
});
