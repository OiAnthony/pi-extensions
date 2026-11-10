import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { normalizeModelRoles } from "@oipsanthony/pi-model-roles";
import {
  PromptPredictionController,
  type PredictionContext,
  type PredictionDependencies,
  type PredictionModel,
} from "./prediction.js";

const main = { provider: "test", id: "main" } as PredictionModel;
const smol = { provider: "test", id: "smol" } as PredictionModel;
const roles = normalizeModelRoles({ roles: { smol: "test/smol:low" } });

function response(text: string, stopReason = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason } as AssistantMessage;
}

function entry(role: string, content: unknown, stopReason = "stop") {
  return { type: "message", message: { role, content, stopReason } };
}

function fixture() {
  const state = {
    draft: "",
    idle: true,
    pending: false,
    session: "session-a",
    leaf: "leaf-a" as string | null,
    branch: [entry("user", "帮我修复这个问题"), entry("assistant", "已修复，可以加回归测试。")],
  };
  const context: PredictionContext = {
    model: main,
    modelRegistry: {
      find: (provider, id) => provider === "test" ? [main, smol].find((model) => model.id === id) : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "yes" }, env: { TEST: "yes" } }),
    },
    ui: { getEditorText: () => state.draft },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sessionManager: {
      getSessionId: () => state.session,
      getLeafId: () => state.leaf,
      getBranch: () => state.branch,
    },
  };
  return { state, context };
}

function setup(implementation: PredictionDependencies["complete"], overrides: Partial<PredictionDependencies> = {}) {
  let renders = 0;
  const controller = new PromptPredictionController(() => renders++, {
    complete: implementation,
    modelRoles: roles,
    ...overrides,
  });
  return { controller, renders: () => renders };
}

describe("prediction model chain", () => {
  for (const failure of ["throw", "error", "aborted", "empty", "multiline", "fence", "controls", "long"] as const) {
    test(`falls back from smol ${failure} exactly once`, async () => {
      const { context } = fixture();
      const calls: PredictionModel[] = [];
      const { controller } = setup(async (model) => {
        calls.push(model);
        if (model === main) return response("加一个回归测试");
        if (failure === "throw") throw new Error("provider failed");
        if (failure === "error" || failure === "aborted") return response("ignored", failure);
        return response({ empty: " ", multiline: "First\nSecond", fence: "```text\nhello\n```", controls: "bad\u001b[31m", long: "x".repeat(501) }[failure]);
      });
      await controller.request(context);
      assert.deepEqual(calls, [smol, main]);
      assert.deepEqual(controller.choices, ["加一个回归测试"]);
    });
  }

  test("NO_PREDICTION is terminal before native main fallback", async () => {
    const { context } = fixture();
    let nativeCalls = 0;
    context.runEphemeralTurn = async () => {
      nativeCalls++;
      return { replyText: "should not appear", assistantMessage: { stopReason: "stop" } };
    };
    const { controller } = setup(async () => response('"NO_PREDICTION"'));
    await controller.request(context);
    assert.equal(nativeCalls, 0);
    assert.equal(controller.choices, undefined);
  });

  test("deduplicates smol resolving to the main provider/id", async () => {
    const { context } = fixture();
    let calls = 0;
    const { controller } = setup(async () => { calls++; return response("", "error"); }, {
      modelRoles: normalizeModelRoles({ roles: { smol: "test/main" } }),
    });
    await controller.request(context);
    assert.equal(calls, 1);
    assert.equal(controller.choices, undefined);
  });

  for (const missing of ["role", "model", "auth"] as const) {
    test(`uses main for missing ${missing}`, async () => {
      const { context } = fixture();
      if (missing === "model") context.modelRegistry.find = () => undefined;
      if (missing === "auth") context.modelRegistry.getApiKeyAndHeaders = async (model) => ({ ok: model === main });
      const calls: PredictionModel[] = [];
      const { controller } = setup(async (model) => { calls.push(model); return response("继续"); },
        missing === "role" ? { modelRoles: normalizeModelRoles({}) } : {});
      await controller.request(context);
      assert.deepEqual(calls, [main]);
      assert.deepEqual(controller.choices, ["继续"]);
    });
  }

  test("native smol takes precedence over the shared role configuration", async () => {
    const { context } = fixture();
    const requests: string[] = [];
    context.models = { resolve: (spec) => { requests.push(spec); return main; } };
    const calls: PredictionModel[] = [];
    const { controller } = setup(async (model) => { calls.push(model); return response("继续"); });
    await controller.request(context);
    assert.deepEqual(requests, ["@smol"]);
    assert.deepEqual(calls, [main]);
  });

  for (const behavior of ["missing", "throws"] as const) {
    test(`native smol ${behavior} bypasses the shared role`, async () => {
      const { context } = fixture();
      context.models = { resolve: () => { if (behavior === "throws") throw new Error("missing"); return undefined; } };
      const calls: PredictionModel[] = [];
      const { controller } = setup(async (model) => { calls.push(model); return response("继续"); });
      await controller.request(context);
      assert.deepEqual(calls, [main]);
    });
  }

  test("main uses the cache-preserving ephemeral API without custom token limits", async () => {
    const { context } = fixture();
    let nativeCalls = 0;
    context.runEphemeralTurn = async (options) => {
      nativeCalls++;
      if ("maxTokens" in options) throw new Error("This transport rejects caller output limits before inference");
      return { replyText: "`加一个回归测试`", assistantMessage: { stopReason: "stop" } };
    };
    const { controller } = setup(async () => { throw new Error("direct completion must not run"); }, { modelRoles: normalizeModelRoles({}) });
    await controller.request(context);
    assert.equal(nativeCalls, 1);
    assert.deepEqual(controller.choices, ["加一个回归测试"]);
  });

});

describe("prediction lifecycle and cancellation", () => {
  for (const mutation of ["session", "leaf", "model", "modelIdentity", "busy", "pending", "draft"] as const) {
    test(`suppresses a late response after ${mutation} changes`, async () => {
      const { context, state } = fixture();
      if (mutation === "modelIdentity") context.model = { ...main };
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<AssistantMessage>();
      const { controller } = setup(async () => { started.resolve(); return result.promise; });
      const request = controller.request(context);
      await started.promise;
      if (mutation === "session") state.session = "session-b";
      if (mutation === "leaf") state.leaf = null;
      if (mutation === "model") context.model = { ...main };
      if (mutation === "modelIdentity") context.model!.id = "changed";
      if (mutation === "busy") state.idle = false;
      if (mutation === "pending") state.pending = true;
      if (mutation === "draft") state.draft = " ";
      result.resolve(response("stale"));
      await request;
      assert.equal(controller.choices, undefined);
    });
  }

  test("typing then erasing cannot resurrect an in-flight suggestion", async () => {
    const { context, state } = fixture();
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<AssistantMessage>();
    let signal: AbortSignal | undefined;
    const { controller } = setup(async (_model, _input, options) => {
      signal = options?.signal;
      started.resolve();
      return result.promise;
    });
    const request = controller.request(context);
    await started.promise;
    state.draft = "x";
    controller.draftChanged("x");
    state.draft = "";
    controller.draftChanged("");
    assert.equal(signal?.aborted, true);
    await request;
    result.resolve(response("late"));
    await Promise.resolve();
    assert.equal(controller.choices, undefined);
  });

  test("cancel settles even when the provider ignores abort, without fallback", async () => {
    const { context } = fixture();
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<AssistantMessage>();
    let calls = 0;
    const { controller, renders } = setup(async () => { calls++; started.resolve(); return result.promise; });
    const request = controller.request(context);
    await started.promise;
    controller.cancel();
    await request;
    result.resolve(response("late"));
    assert.equal(calls, 1);
    assert.equal(renders(), 0);
    assert.equal(controller.choices, undefined);
  });

  test("an overall deadline settles an abort-ignoring provider without main fallback", async () => {
    const { context } = fixture();
    const result = Promise.withResolvers<AssistantMessage>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const { controller } = setup(async (_model, _input, options) => {
      calls++;
      signal = options?.signal;
      return result.promise;
    }, { deadlineMs: 0 });
    await controller.request(context);
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1);
    assert.equal(controller.choices, undefined);
    result.resolve(response("late"));
  });

  test("cancel during authentication never starts inference or main resolution", async () => {
    const { context } = fixture();
    const started = Promise.withResolvers<void>();
    const auth = Promise.withResolvers<{ ok: boolean }>();
    let lookups = 0;
    let calls = 0;
    context.modelRegistry.getApiKeyAndHeaders = async () => { lookups++; started.resolve(); return auth.promise; };
    const { controller } = setup(async () => { calls++; return response("unexpected"); });
    const request = controller.request(context);
    await started.promise;
    controller.cancel();
    await request;
    auth.resolve({ ok: true });
    assert.equal(lookups, 1);
    assert.equal(calls, 0);
  });

  test("new request supersedes old request without stale clearing", async () => {
    const { context } = fixture();
    const first = Promise.withResolvers<AssistantMessage>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const { controller } = setup(async () => {
      if (++calls === 1) { started.resolve(); return first.promise; }
      return response("new prediction");
    });
    const old = controller.request(context);
    await started.promise;
    await controller.request(context);
    await old;
    first.resolve(response("old prediction"));
    assert.deepEqual(controller.choices, ["new prediction"]);
  });

  test("prefix drafts retain choices; diverging drafts and cancel render only display changes", async () => {
    const { context } = fixture();
    const { controller, renders } = setup(async () => response("继续测试"));
    await controller.request(context);
    assert.equal(renders(), 1);
    controller.draftChanged("继续");
    controller.draftChanged("");
    assert.deepEqual(controller.choices, ["继续测试"]);
    assert.equal(renders(), 1);
    controller.draftChanged("不");
    assert.equal(controller.choices, undefined);
    assert.equal(renders(), 2);
    controller.cancel();
    controller.cancel();
    assert.equal(renders(), 2);
  });

  for (const reason of ["draft", "busy", "pending", "model"] as const) {
    test(`skips an ineligible ${reason} context`, async () => {
      const { context, state } = fixture();
      if (reason === "draft") state.draft = " ";
      if (reason === "busy") state.idle = false;
      if (reason === "pending") state.pending = true;
      if (reason === "model") context.model = undefined;
      let calls = 0;
      const { controller } = setup(async () => { calls++; return response("unexpected"); });
      await controller.request(context);
      assert.equal(calls, 0);
    });
  }
});

describe("bounded human transcript", () => {
  for (const stopReason of ["error", "aborted", "toolUse", "length"]) {
    test(`latest assistant ${stopReason} suppresses older successful responses`, async () => {
      const { context, state } = fixture();
      state.branch.push(entry("assistant", [], stopReason));
      let calls = 0;
      const { controller } = setup(async () => { calls++; return response("unexpected"); });
      await controller.request(context);
      assert.equal(calls, 0);
    });
  }

  test("requires human text and a successful actual assistant", async () => {
    for (const branch of [[entry("assistant", "done")], [entry("user", "hello")], [entry("user", [{ type: "image", data: "secret" }]), entry("assistant", "done")]]) {
      const { context, state } = fixture();
      state.branch = branch;
      let calls = 0;
      const { controller } = setup(async () => { calls++; return response("unexpected"); });
      await controller.request(context);
      assert.equal(calls, 0);
    }
  });

  test("retains newest 12 text messages, excluding tools, thinking, images and metadata", async () => {
    const { context, state } = fixture();
    state.branch = Array.from({ length: 20 }, (_, index) => entry(index % 2 ? "assistant" : "user", `message-${index}`));
    state.branch.push(entry("toolResult", "tool-secret"));
    state.branch.push(entry("assistant", [
      { type: "thinking", thinking: "thinking-secret" },
      { type: "toolCall", name: "tool-secret" },
      { type: "image", data: "image-secret" },
    ]));
    const { controller } = setup(async (_model, input) => {
      const message = input.messages[0]!;
      const content = message.content as Array<{ text: string }>;
      const text = content[0]!.text;
      const match = text.match(/<conversation-json>\n([\s\S]*)\n<\/conversation-json>$/u);
      assert.ok(match?.[1]);
      const transcript = JSON.parse(match[1]) as Array<{ role: string; text: string }>;
      assert.equal(transcript.length, 12);
      assert.equal(transcript[0]?.text, "message-8");
      assert.equal(transcript.at(-1)?.text, "message-19");
      assert.doesNotMatch(text, /secret/);
      return response("继续");
    });
    await controller.request(context);
    assert.deepEqual(controller.choices, ["继续"]);
  });

  test("bounds total text to 24000 UTF-16 characters, preserving newest text", async () => {
    const { context, state } = fixture();
    state.branch = [entry("user", "u".repeat(20_000)), entry("assistant", "a".repeat(20_000))];
    const { controller } = setup(async (_model, input) => {
      const content = input.messages[0]!.content as Array<{ text: string }>;
      const match = content[0]!.text.match(/<conversation-json>\n([\s\S]*)\n<\/conversation-json>$/u);
      assert.ok(match?.[1]);
      const messages = JSON.parse(match[1]) as Array<{ text: string }>;
      assert.equal(messages.reduce((sum, message) => sum + message.text.length, 0), 24_000);
      assert.equal(messages[0]?.text.length, 4000);
      assert.equal(messages[1]?.text, "a".repeat(20_000));
      return response("继续");
    });
    await controller.request(context);
    assert.deepEqual(controller.choices, ["继续"]);
  });
});
