import { describe, expect, test } from "bun:test";
import { installPredictionEditor, type PredictionEditorHooks } from "./editor.js";

type EditorUI = Parameters<typeof installPredictionEditor>[0];
type EditorFactory = NonNullable<Parameters<EditorUI["setEditorComponent"]>[0]>;

class FakeEditor {
  text = "";
  predictions?: () => readonly string[] | undefined;
  onPredictionAccepted?: (index: number) => void;
  onPredictionShown?: () => void;
  onChange?: (text: string) => void;

  getText() {
    return this.text;
  }

  setText(text: string) {
    this.text = text;
    this.onChange?.(this.text);
  }

  handleInput(input: string) {
    if (input === "arrow") return;
    if (input === "nested") {
      this.setText(`${this.text}!`);
      return;
    }
    if (input === "tab") {
      const choices = this.predictions?.();
      if (choices?.[0]?.startsWith(this.text)) {
        // Native OMP inserts through a private method, not public setText.
        this.text = choices[0];
        this.onChange?.(this.text);
        this.onPredictionAccepted?.(0);
      }
      return;
    }
    this.text += input;
    this.onChange?.(this.text);
  }

  mutatePrivately(text: string) {
    this.text = text;
    this.onChange?.(this.text);
  }
}

function harness(initial?: FakeEditor) {
  const nativeAccepted: number[] = [];
  const nativeChanges: string[] = [];
  let nativeShown = 0;
  let renders = 0;
  let sets = 0;
  let current = initial ?? new FakeEditor();
  const previousFactory: EditorFactory = () => {
    // Only this test boundary adapts the small fake to the host editor type.
    return current as unknown as ReturnType<EditorFactory>;
  };
  let factory: EditorFactory | undefined = previousFactory;
  const tui = { requestRender: () => { renders++; } } as Parameters<EditorFactory>[0];
  const ui: EditorUI = {
    getEditorComponent: () => factory,
    setEditorComponent(next) {
      sets++;
      factory = next;
      if (!next) return;
      const editor = next(tui, {} as Parameters<EditorFactory>[1], {} as Parameters<EditorFactory>[2]);
      current = editor as unknown as FakeEditor;
      // Faithfully reproduce host assignments after the factory returns.
      current.predictions = () => ["native suggestion"];
      current.onPredictionAccepted = function (index) {
        expect(this).toBe(current);
        nativeAccepted.push(index);
      };
      current.onPredictionShown = function () {
        expect(this).toBe(current);
        nativeShown++;
      };
      current.onChange = function (text) {
        expect(this).toBe(current);
        nativeChanges.push(text);
      };
    },
  };
  let choices: readonly string[] | undefined = ["extension suggestion"];
  let accepted = 0;
  const drafts: string[] = [];
  const hooks: PredictionEditorHooks = {
    choices: () => choices,
    accepted() {
      accepted++;
      choices = undefined;
    },
    draftChanged(text) {
      drafts.push(text);
      if (choices && !choices.some(choice => choice.startsWith(text))) choices = undefined;
    },
  };
  return {
    ui,
    hooks,
    previousFactory,
    nativeAccepted,
    drafts,
    nativeChanges,
    get editor() { return current; },
    get nativeShown() { return nativeShown; },
    get renders() { return renders; },
    get sets() { return sets; },
    get accepted() { return accepted; },
    set choices(value: readonly string[] | undefined) { choices = value; },
  };
}

describe("native prediction editor integration", () => {
  test("survives host post-factory assignment and attributes extension acceptance only to hooks", () => {
    const h = harness();
    const original = h.editor;
    const binding = installPredictionEditor(h.ui, h.hooks);
    expect(h.editor).toBe(original);
    expect(h.editor.predictions?.()).toEqual(["extension suggestion"]);
    h.editor.onPredictionShown?.();
    expect(h.nativeShown).toBe(0);
    h.editor.handleInput("tab");
    expect(h.editor.getText()).toBe("extension suggestion");
    expect(h.accepted).toBe(1);
    expect(h.nativeAccepted).toEqual([]);
    expect(h.drafts).toEqual(["extension suggestion"]);
    binding.requestRender();
    expect(h.renders).toBe(1);
  });

  test("preserves native provider and callbacks when extension choices are absent or empty", () => {
    const h = harness();
    installPredictionEditor(h.ui, h.hooks);
    for (const choices of [undefined, []]) {
      h.choices = choices;
      expect(h.editor.predictions?.()).toEqual(["native suggestion"]);
      h.editor.onPredictionShown?.();
      h.editor.onPredictionAccepted?.(2);
    }
    expect(h.nativeShown).toBe(2);
    expect(h.nativeAccepted).toEqual([2, 2]);
    expect(h.accepted).toBe(0);
  });

  test("uses supplied prediction attribution even if hooks have changed before the callback", () => {
    const h = harness();
    installPredictionEditor(h.ui, h.hooks);
    h.editor.predictions?.();
    h.choices = undefined;
    h.editor.onPredictionAccepted?.(0);
    expect(h.accepted).toBe(1);
    expect(h.nativeAccepted).toEqual([]);
    h.editor.predictions?.();
    h.choices = ["new extension suggestion"];
    h.editor.onPredictionAccepted?.(1);
    expect(h.nativeAccepted).toEqual([1]);
    expect(h.accepted).toBe(1);
  });

  test("observes actual input and external setText changes once without swallowing editor behavior", () => {
    const editor = new FakeEditor();
    let customInputs = 0;
    const originalInput = editor.handleInput;
    editor.handleInput = function (input) {
      customInputs++;
      originalInput.call(this, input);
    };
    const h = harness(editor);
    installPredictionEditor(h.ui, h.hooks);
    editor.handleInput("arrow");
    editor.setText("");
    expect(h.drafts).toEqual([]);
    editor.handleInput("e");
    editor.handleInput("nested");
    editor.setText("external replacement");
    editor.setText("external replacement");
    editor.mutatePrivately("native text assist");
    editor.onChange?.("native text assist");
    expect(customInputs).toBe(3);
    expect(h.drafts).toEqual(["e", "e!", "external replacement", "native text assist"]);
    expect(h.nativeChanges).toEqual(["", "e", "e!", "external replacement", "external replacement", "native text assist", "native text assist"]);
  });

  test("restores the previous factory once and releases native callbacks on dispose", () => {
    const h = harness();
    const originalInput = h.editor.handleInput;
    const originalSetText = h.editor.setText;
    const binding = installPredictionEditor(h.ui, h.hooks);
    h.editor.predictions?.();
    binding.dispose();
    expect(h.ui.getEditorComponent()).toBe(h.previousFactory);
    expect(h.editor.handleInput).toBe(originalInput);
    expect(h.editor.setText).toBe(originalSetText);
    expect(h.editor.predictions?.()).toEqual(["native suggestion"]);
    h.editor.onPredictionAccepted?.(3);
    h.editor.onPredictionShown?.();
    expect(h.nativeAccepted).toEqual([3]);
    expect(h.nativeShown).toBe(1);
    h.editor.mutatePrivately("after disposal");
    expect(h.nativeChanges).toEqual(["after disposal"]);
    expect(h.drafts).toEqual([]);
    expect(h.accepted).toBe(0);
    binding.requestRender();
    binding.dispose();
    expect(h.renders).toBe(0);
    expect(h.sets).toBe(2);
  });

  test("does not clobber a later editor extension or its method replacements on disposal", () => {
    const h = harness();
    const binding = installPredictionEditor(h.ui, h.hooks);
    const ours = h.ui.getEditorComponent()!;
    const later: EditorFactory = (...args) => ours(...args);
    h.ui.setEditorComponent(later);
    const laterInput = () => { h.editor.text = "later"; };
    h.editor.handleInput = laterInput;
    binding.dispose();
    expect(h.ui.getEditorComponent()).toBe(later);
    expect(h.editor.handleInput).toBe(laterInput);
    expect(h.editor.predictions?.()).toEqual(["native suggestion"]);
    h.editor.onPredictionAccepted?.(4);
    expect(h.nativeAccepted).toEqual([4]);
    expect(h.accepted).toBe(0);
    expect(h.sets).toBe(2);
  });

  test("composes existing accessor-based prediction extensions and restores their descriptors", () => {
    const editor = new FakeEditor();
    let upstream: (() => readonly string[] | undefined) | undefined;
    const get = () => () => upstream?.();
    const set = (value: (() => readonly string[] | undefined) | undefined) => { upstream = value; };
    Object.defineProperty(editor, "predictions", { configurable: true, get, set });
    const h = harness(editor);
    const binding = installPredictionEditor(h.ui, h.hooks);
    h.choices = undefined;
    expect(editor.predictions?.()).toEqual(["native suggestion"]);
    h.choices = ["extension suggestion"];
    expect(editor.predictions?.()).toEqual(["extension suggestion"]);
    const ours = h.ui.getEditorComponent()!;
    h.ui.setEditorComponent((...args) => ours(...args));
    // Another extension's independently replaced descriptor is not ours to undo.
    const accepted = () => {};
    Object.defineProperty(editor, "onPredictionAccepted", { configurable: true, value: accepted });
    binding.dispose();
    expect(Object.getOwnPropertyDescriptor(editor, "predictions")?.get).toBe(get);
    expect(editor.predictions?.()).toEqual(["native suggestion"]);
    expect(editor.onPredictionAccepted).toBe(accepted);
  });
});
