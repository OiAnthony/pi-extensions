import { describe, expect, test } from "bun:test";
import {
  PREDICTION_WIDGET_KEY,
  installOmpPredictionComposer,
  type OmpComposerKey,
  type OmpPredictionUI,
  type OmpWidgetFactory,
  type PredictionEditorHooks,
} from "./editor.js";

function harness(initialChoice: string | undefined = "extension suggestion", initialStatus?: string) {
  let text = "";
  let choices: readonly string[] | undefined = initialChoice ? [initialChoice] : undefined;
  let status: string | undefined = initialStatus;
  let accepted = 0;
  let cancelled = 0;
  const drafts: string[] = [];
  const keyHandlers = new Set<(key: OmpComposerKey) => boolean>();
  const decorators = new Set<(text: string) => ReadonlyArray<{ from: number; to: number; s: string }>>();
  let widget: string[] | OmpWidgetFactory | undefined;
  let widgetRows: { render(width: number): string[] } | undefined;
  let widgetPlacement: "aboveEditor" | "belowEditor" | undefined;
  let setWidgetCalls = 0;
  let widgetRenderRequests = 0;
  const widgetTui = {
    requestRender() {
      widgetRenderRequests++;
    },
  };
  const theme = {
    fg: (color: "accent" | "dim" | "muted", value: string) => `<${color}>${value}</${color}>`,
  };

  const ui: OmpPredictionUI = {
    theme,
    composer: {
      addKeyHandler(handler) {
        keyHandlers.add(handler);
        return () => { keyHandlers.delete(handler); };
      },
      addDecorator(decorator) {
        decorators.add(decorator);
        return () => { decorators.delete(decorator); };
      },
    },
    getEditorText: () => text,
    setEditorText(next: string) {
      text = next;
      for (const decorator of decorators) decorator(text);
    },
    setWidget(key, content, options) {
      expect(key).toBe(PREDICTION_WIDGET_KEY);
      setWidgetCalls++;
      widget = content;
      widgetPlacement = options?.placement;
      widgetRows = typeof content === "function" ? content(widgetTui, theme) : undefined;
    },
  };

  const hooks: PredictionEditorHooks = {
    choices: () => choices,
    status: () => status,
    accepted() {
      accepted++;
      if (choices && !choices[0]!.startsWith(text)) choices = undefined;
    },
    cancelled() {
      cancelled++;
      choices = undefined;
    },
    draftChanged(next) {
      drafts.push(next);
      if (choices && !choices[0]!.startsWith(next)) choices = undefined;
    },
  };

  const press = (id: string): boolean => {
    for (const handler of keyHandlers) {
      if (handler({ id })) return true;
    }
    return false;
  };

  const renderWidget = (width = 80): string[] | undefined => {
    if (!widget) return undefined;
    if (Array.isArray(widget)) return widget;
    return (widgetRows ?? widget(widgetTui, theme)).render(width);
  };
  return {
    ui,
    hooks,
    drafts,
    press,
    renderWidget,
    type(next: string) {
      text = next;
      for (const decorator of decorators) decorator(text);
    },
    get text() { return text; },
    get accepted() { return accepted; },
    get cancelled() { return cancelled; },
    get widgetPlacement() { return widgetPlacement; },
    get setWidgetCalls() { return setWidgetCalls; },
    get widgetRenderRequests() { return widgetRenderRequests; },
    get keyHandlerCount() { return keyHandlers.size; },
    get decoratorCount() { return decorators.size; },
    set choices(value: readonly string[] | undefined) { choices = value; },
    set status(value: string | undefined) { status = value; },
  };
}

describe("OMP 19.x prediction composer integration", () => {
  test("renders above-editor widget with a bottom spacer row, refreshes in place, and accepts with Tab or empty Right", () => {
    const h = harness("加一个中文回归测试");
    const binding = installOmpPredictionComposer(h.ui, h.hooks);

    binding.requestRender();
    expect(h.setWidgetCalls).toBe(1);
    expect(h.widgetPlacement).toBe("aboveEditor");
    expect(h.renderWidget(80)).toEqual(["<accent> ↳ </accent><muted>加一个中文回归测试</muted><dim>  [Tab / →]</dim>", " "]);
    expect(h.renderWidget(24)).toEqual(["<accent> ↳ </accent><muted>加一个中…</muted><dim>  [Tab / →]</dim>", " "]);

    expect(h.press("right")).toBe(true);
    expect(h.text).toBe("加一个中文回归测试");
    expect(h.accepted).toBe(1);
    expect(h.renderWidget(80)).toBeUndefined();

    // Clearing the draft brings the still-matching prediction back.
    h.type("");
    expect(h.renderWidget(80)).toEqual(["<accent> ↳ </accent><muted>加一个中文回归测试</muted><dim>  [Tab / →]</dim>", " "]);

    // Non-empty matching prefix updates in place via tui.requestRender without remounting.
    const callsBeforePrefix = h.setWidgetCalls;
    h.type("加一个");
    expect(h.setWidgetCalls).toBe(callsBeforePrefix);
    expect(h.widgetRenderRequests).toBe(1);
    expect(h.renderWidget(80)).toEqual(["<accent> ↳ </accent><dim>加一个</dim><muted>中文回归测试</muted><dim>  [Tab]</dim>", " "]);
    expect(h.press("right")).toBe(false);
    expect(h.press("tab")).toBe(true);
    expect(h.text).toBe("加一个中文回归测试");
    expect(h.accepted).toBe(2);
    expect(h.renderWidget(80)).toBeUndefined();

    binding.dispose();
  });

  test("renders pending status on an empty draft without accepting Tab or Right, then switches to prediction", () => {
    const h = harness("", "Predicting next prompt…");
    const binding = installOmpPredictionComposer(h.ui, h.hooks);

    binding.requestRender();
    expect(h.renderWidget(80)).toEqual(["<accent> ↳ </accent><dim>Predicting next prompt…</dim>", " "]);
    expect(h.press("tab")).toBe(false);
    expect(h.press("right")).toBe(false);
    expect(h.text).toBe("");
    expect(h.accepted).toBe(0);

    h.status = undefined;
    h.choices = ["继续测试"];
    binding.requestRender();
    expect(h.renderWidget(80)).toEqual(["<accent> ↳ </accent><muted>继续测试</muted><dim>  [Tab / →]</dim>", " "]);

    h.choices = undefined;
    binding.requestRender();
    expect(h.renderWidget(80)).toBeUndefined();
    binding.dispose();
  });

  test("Escape cancels an active prediction and passes through when none is shown", () => {
    const h = harness("continue testing");
    const binding = installOmpPredictionComposer(h.ui, h.hooks);
    binding.requestRender();

    expect(h.press("escape")).toBe(true);
    expect(h.cancelled).toBe(1);
    expect(h.renderWidget(80)).toBeUndefined();

    expect(h.press("escape")).toBe(false);
    expect(h.cancelled).toBe(1);
    binding.dispose();
  });

  test("divergent draft via decorator notifies hooks and clears the widget", () => {
    const h = harness("run unit tests");
    const binding = installOmpPredictionComposer(h.ui, h.hooks);
    binding.requestRender();
    expect(h.renderWidget(80)).toEqual(["<accent> ↳ </accent><muted>run unit tests</muted><dim>  [Tab / →]</dim>", " "]);

    h.type("unrelated");
    expect(h.drafts).toEqual(["unrelated"]);
    expect(h.renderWidget(80)).toBeUndefined();
    expect(h.press("tab")).toBe(false);
    binding.dispose();
  });

  test("dispose removes composer hooks and clears the widget once", () => {
    const h = harness("extension suggestion");
    const binding = installOmpPredictionComposer(h.ui, h.hooks);
    binding.requestRender();
    expect(h.keyHandlerCount).toBe(1);
    expect(h.decoratorCount).toBe(1);

    binding.dispose();
    expect(h.keyHandlerCount).toBe(0);
    expect(h.decoratorCount).toBe(0);
    expect(h.renderWidget(80)).toBeUndefined();

    const callsAfterDispose = h.setWidgetCalls;
    binding.requestRender();
    binding.dispose();
    expect(h.setWidgetCalls).toBe(callsAfterDispose);
  });

  test("returns a no-op binding when ui.composer is unavailable", () => {
    const h = harness("extension suggestion");
    const binding = installOmpPredictionComposer({ ...h.ui, composer: undefined }, h.hooks);
    binding.requestRender();
    binding.dispose();
    expect(h.setWidgetCalls).toBe(0);
  });
});
