import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "./index.js";
import type { PredictionContext, PredictionModel } from "./prediction.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
type Factory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

function harness(runtime: "pi" | "omp" = "pi", overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const pi = { on(name: string, handler: Handler) {
    handlers.set(name, [...handlers.get(name) ?? [], handler]);
  } } as unknown as ExtensionAPI;
  const model = { provider: "test", id: "main" } as PredictionModel;
  let calls = 0;
  let compatCalls = 0;
  let installations = 0;
  let text = "";
  let factory: Factory | undefined;
  const editor = {
    getText: () => text,
    setText(value: string) { text = value; this.onChange?.(value); },
    onChange: undefined as ((text: string) => void) | undefined,
  };
  const context = {
    hasUI: true,
    mode: "tui",
    ...(runtime === "omp" ? { agent: { kind: "main" } } : {}),
    model,
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      streamSimple: () => {
        calls++;
        return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "继续" }], stopReason: "stop" }) };
      },
    },
    ui: {
      theme: {},
      getEditorText: () => text,
      getEditorComponent: () => factory,
      setEditorComponent(next: Factory | undefined) {
        factory = next;
        installations++;
        next?.({ requestRender() {} } as Parameters<Factory>[0], {} as Parameters<Factory>[1], {} as Parameters<Factory>[2]);
      },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "session-a",
      getLeafId: () => "leaf-a",
      getBranch: () => [
        { type: "message", message: { role: "user", content: "给我一个测试示例" } },
        { type: "message", message: { role: "assistant", content: "可以继续给你示例，需要吗？", stopReason: "stop" } },
      ],
    },
    ...overrides,
  };
  // A pre-existing custom editor factory must survive installation and disposal.
  const previous: Factory = () => editor as unknown as ReturnType<Factory>;
  factory = previous;
  register(pi, {
    complete: async () => { compatCalls++; throw new Error("host registry must be used"); },
  });
  return {
    context: context as unknown as ExtensionContext & PredictionContext,
    editor,
    previous,
    get factory() { return factory; },
    get calls() { return calls; },
    get compatCalls() { return compatCalls; },
    get installations() { return installations; },
    async emit(name: string, event: Record<string, unknown> = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, context as unknown as ExtensionContext);
    },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 1));

describe("prediction runtime lifecycle", () => {
  test("Pi waits through intermediate agent_end events and requests once after agent_settled", async () => {
    const h = harness();
    await h.emit("session_start");
    expect(h.installations).toBe(1);
    for (let index = 0; index < 3; index++) await h.emit("agent_end");
    await flush();
    expect(h.calls).toBe(0);
    await h.emit("agent_settled");
    await flush();
    expect(h.calls).toBe(1);
    expect(h.compatCalls).toBe(0);
  });

  test("OMP requests on final agent_end without requiring agent_settled", async () => {
    const h = harness("omp");
    await h.emit("session_start");
    await h.emit("agent_end", { willContinue: true });
    await flush();
    expect(h.calls).toBe(0);
    await h.emit("agent_end", { willContinue: false });
    await flush();
    expect(h.calls).toBe(1);
    await h.emit("agent_settled");
    await flush();
    expect(h.calls).toBe(1);
  });

  for (const event of ["input", "agent_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "model_select", "session_shutdown"]) {
    test(`${event} cancels a scheduled Pi prediction`, async () => {
      const h = harness();
      await h.emit("session_start");
      await h.emit("agent_settled");
      await h.emit(event);
      await flush();
      expect(h.calls).toBe(0);
    });
  }

  test("typing cancels a scheduled request even if the draft is erased before it starts", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("agent_settled");
    h.editor.setText("草稿");
    h.editor.setText("");
    await flush();
    expect(h.calls).toBe(0);
  });

  test("shutdown restores the custom factory and prevents later requests", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("session_shutdown");
    expect(h.factory).toBe(h.previous);
    await h.emit("agent_settled");
    await flush();
    expect(h.calls).toBe(0);
  });

  for (const overrides of [{ hasUI: false }, { mode: "rpc" }, { mode: "print" }, { mode: "json" }, { agent: { kind: "sub" } }]) {
    test(`skips ineligible runtime ${JSON.stringify(overrides)}`, async () => {
      const h = harness("pi", overrides);
      await h.emit("session_start");
      await h.emit("agent_end");
      await h.emit("agent_settled");
      await flush();
      expect(h.installations).toBe(0);
      expect(h.calls).toBe(0);
    });
  }
});
