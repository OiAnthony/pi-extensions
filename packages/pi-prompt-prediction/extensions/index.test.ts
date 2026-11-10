import { describe, expect, test } from "bun:test";
import type { CustomEditor, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { normalizeModelRoles } from "@oipsanthony/pi-model-roles";
import register from "./index.js";
import type { PredictionModel } from "./prediction.js";

type EditorUI = Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
type EditorFactory = NonNullable<Parameters<EditorUI["setEditorComponent"]>[0]>;

class DraftEditor {
  private text = "";
  predictions?: () => readonly string[] | undefined;
  onPredictionAccepted?: (index: number) => void;
  onChange?: (text: string) => void;

  getText() { return this.text; }
  setText(text: string) {
    this.text = text;
    this.onChange?.(text);
  }
  acceptPrediction() {
    const prediction = this.predictions?.()?.[0];
    if (!prediction || prediction === this.text || !prediction.startsWith(this.text)) return;
    this.setText(prediction);
    this.onPredictionAccepted?.(0);
  }
}

async function harness() {
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
  const editor = new DraftEditor();
  const rendered = Promise.withResolvers<void>();
  let factory: EditorFactory | undefined = () => editor as unknown as CustomEditor;
  let requests = 0;
  const model = { provider: "test", id: "main" } as PredictionModel;
  const ui: EditorUI = {
    getEditorComponent: () => factory,
    setEditorComponent(next) {
      factory = next;
      next?.({ requestRender: rendered.resolve } as Parameters<EditorFactory>[0],
        {} as Parameters<EditorFactory>[1], {} as Parameters<EditorFactory>[2]);
      editor.predictions = () => undefined;
    },
  };
  const context = {
    hasUI: true, mode: "tui", agent: { kind: "main" }, model,
    ui: { ...ui, getEditorText: () => editor.getText() },
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: {
      find: () => model,
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
  register({ on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI, {
    modelRoles: normalizeModelRoles({}),
    complete: async () => {
      requests++;
      return { role: "assistant", content: [{ type: "text", text: "继续测试" }], stopReason: "stop" } as AssistantMessage;
    },
  });
  const emit = (name: string) => handlers.get(name)?.({}, context);
  emit("session_start");
  emit("agent_end");
  await rendered.promise;
  return { editor, emit, requests: () => requests };
}

describe("accepted prediction lifecycle", () => {
  test("accepting then clearing a draft allows repeated acceptance without another model request", async () => {
    const h = await harness();
    try {
      expect(h.editor.predictions?.()).toEqual(["继续测试"]);
      for (let attempt = 0; attempt < 3; attempt++) {
        h.editor.acceptPrediction();
        expect(h.editor.getText()).toBe("继续测试");
        h.editor.setText("");
        expect(h.editor.predictions?.()).toEqual(["继续测试"]);
      }
      h.editor.setText("继续");
      h.editor.acceptPrediction();
      expect(h.editor.getText()).toBe("继续测试");
      expect(h.requests()).toBe(1);
    } finally {
      h.emit("session_shutdown");
    }
  });

  for (const invalidation of ["input", "agent_start", "model_select", "session_before_switch", "divergent draft"]) {
    test(`does not restore an accepted prediction after ${invalidation}`, async () => {
      const h = await harness();
      try {
        h.editor.acceptPrediction();
        expect(h.editor.getText()).toBe("继续测试");
        if (invalidation === "divergent draft") h.editor.setText("不同的问题");
        else h.emit(invalidation);
        h.editor.setText("");
        h.editor.acceptPrediction();
        expect(h.editor.getText()).toBe("");
        expect(h.editor.predictions?.()).toBeUndefined();
        expect(h.requests()).toBe(1);
      } finally {
        h.emit("session_shutdown");
      }
    });
  }
});
