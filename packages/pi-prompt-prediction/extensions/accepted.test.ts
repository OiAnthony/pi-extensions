import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { OmpComposerKey, OmpWidgetFactory } from "./editor.js";
import register from "./index.js";
import type { PredictionModel } from "./prediction.js";

async function harness() {
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const keyHandlers = new Set<(key: OmpComposerKey) => boolean>();
  const decorators = new Set<(text: string) => ReadonlyArray<{ from: number; to: number; s: string }>>();
  let text = "";
  let widget: string[] | OmpWidgetFactory | undefined;
  let widgetRows: { render(width: number): string[] } | undefined;
  const rendered = Promise.withResolvers<void>();
  let requests = 0;
  const model = { provider: "test", id: "main" } as PredictionModel;
  const theme = { fg: (_color: "accent" | "dim" | "muted", value: string) => value };

  const shown = () => (widgetRows ? widgetRows.render(80)[0] : Array.isArray(widget) ? widget[0] : undefined);
  const checkRendered = () => {
    if (shown()?.includes("继续测试")) rendered.resolve();
  };
  const widgetTui = {
    requestRender: checkRendered,
  };

  const setDraft = (next: string) => {
    text = next;
    for (const decorator of decorators) decorator(text);
  };

  const context = {
    hasUI: true,
    mode: "tui",
    agent: { kind: "main" },
    model,
    ui: {
      theme,
      composer: {
        addKeyHandler(handler: (key: OmpComposerKey) => boolean) {
          keyHandlers.add(handler);
          return () => { keyHandlers.delete(handler); };
        },
        addDecorator(decorator: (text: string) => ReadonlyArray<{ from: number; to: number; s: string }>) {
          decorators.add(decorator);
          return () => { decorators.delete(decorator); };
        },
      },
      getEditorText: () => text,
      setEditorText: setDraft,
      setWidget(_key: string, content: string[] | OmpWidgetFactory | undefined) {
        widget = content;
        widgetRows = typeof content === "function" ? content(widgetTui, theme) : undefined;
        checkRendered();
      },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getBranch: () => [
        { type: "message", message: { role: "user", content: "修复问题" } },
        { type: "message", message: { role: "assistant", content: "已修复。", stopReason: "stop" } },
      ],
    },
  } as unknown as ExtensionContext;

  register({
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI, {
    complete: async () => {
      requests++;
      return { role: "assistant", content: [{ type: "text", text: "继续测试" }], stopReason: "stop" } as AssistantMessage;
    },
  });

  const emit = (name: string) => handlers.get(name)?.({}, context);
  const press = (id: string) => {
    for (const handler of keyHandlers) {
      if (handler({ id })) return true;
    }
    return false;
  };

  await emit("session_start");
  await emit("agent_end");
  await rendered.promise;
  return {
    getText: () => text,
    setText: setDraft,
    press,
    shown,
    emit,
    requests: () => requests,
  };
}

describe("accepted prediction lifecycle", () => {
  test("accepting then clearing a draft allows repeated acceptance without another model request", async () => {
    const h = await harness();
    try {
      expect(h.shown()).toContain("继续测试");
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(h.press("tab")).toBe(true);
        expect(h.getText()).toBe("继续测试");
        expect(h.shown()).toBeUndefined();
        h.setText("");
        expect(h.shown()).toContain("继续测试");
      }
      h.setText("继续");
      expect(h.press("tab")).toBe(true);
      expect(h.getText()).toBe("继续测试");
      expect(h.requests()).toBe(1);
    } finally {
      await h.emit("session_shutdown");
    }
  });

  for (const invalidation of ["input", "agent_start", "model_select", "session_before_switch", "divergent draft"]) {
    test(`does not restore an accepted prediction after ${invalidation}`, async () => {
      const h = await harness();
      try {
        expect(h.press("tab")).toBe(true);
        expect(h.getText()).toBe("继续测试");
        if (invalidation === "divergent draft") h.setText("不同的问题");
        else await h.emit(invalidation);
        h.setText("");
        expect(h.press("tab")).toBe(false);
        expect(h.getText()).toBe("");
        expect(h.shown()).toBeUndefined();
        expect(h.requests()).toBe(1);
      } finally {
        await h.emit("session_shutdown");
      }
    });
  }
});
