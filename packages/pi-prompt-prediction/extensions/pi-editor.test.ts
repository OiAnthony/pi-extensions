import { describe, expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { PiEditorUI, PredictionEditorHooks } from "./editor.js";
import { installPiPredictionEditor } from "./pi-editor.js";

type EditorUI = PiEditorUI;
type Factory = NonNullable<Parameters<EditorUI["setEditorComponent"]>[0]>;

function harness(choice = "加一个中文回归测试 👩‍💻") {
  let choices: readonly string[] | undefined = [choice];
  let accepted = 0;
  let cancelled = 0;
  let renders = 0;
  let submissions = 0;
  const drafts: string[] = [];
  const keybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
  }) as unknown as Parameters<Factory>[2];
  const tui = { terminal: { rows: 40 }, requestRender: () => { renders++; } } as Parameters<Factory>[0];
  const editorTheme = { borderColor: (text: string) => text, selectList: {} } as Parameters<Factory>[1];
  const editor = new CustomEditor(tui, editorTheme, keybindings);
  editor.focused = true;
  const previous: Factory = () => editor;
  let factory: Factory | undefined = previous;
  const ui: EditorUI = {
    theme: {
      fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`,
      inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
    } as EditorUI["theme"],
    getEditorComponent: () => factory,
    setEditorComponent(next) {
      factory = next;
      next?.(tui, editorTheme, keybindings);
      // The host installs these after invoking a custom editor factory.
      editor.onChange = text => drafts.push(text);
      editor.onSubmit = () => { submissions++; };
    },
  };
  const hooks: PredictionEditorHooks = {
    choices: () => choices,
    accepted: () => { accepted++; choices = undefined; },
    cancelled: () => { cancelled++; choices = undefined; },
    draftChanged: text => { if (!choices?.[0]?.startsWith(text)) choices = undefined; },
  };
  const originalRender = editor.render;
  const originalInput = editor.handleInput;
  const binding = installPiPredictionEditor(ui, hooks);
  return {
    editor, ui, binding, drafts, keybindings, previous, originalRender, originalInput,
    get accepted() { return accepted; },
    get cancelled() { return cancelled; },
    get renders() { return renders; },
    get submissions() { return submissions; },
    set choices(value: readonly string[] | undefined) { choices = value; },
  };
}

describe("Pi prediction editor with the real CustomEditor", () => {
  test("renders ghost text without modifying the draft, cursor or undo history", () => {
    const h = harness();
    const lines = h.editor.render(60);
    expect(lines.join("\n")).toContain("一个中文回归测试");
    expect(lines.join("\n").split(CURSOR_MARKER)).toHaveLength(2);
    expect(h.editor.getText()).toBe("");
    expect(h.editor.getCursor()).toEqual({ line: 0, col: 0 });
    expect(h.drafts).toEqual([]);
    h.editor.handleInput("\x1f"); // Default Ctrl+- undo.
    expect(h.editor.getText()).toBe("");
  });

  for (const key of ["\t", "\x1b[C"]) {
    test(`accepts ${JSON.stringify(key)} atomically without submitting`, () => {
      const h = harness();
      h.editor.setText("加一个");
      h.editor.handleInput(key);
      expect(h.editor.getText()).toBe("加一个中文回归测试 👩‍💻");
      expect(h.accepted).toBe(1);
      expect(h.submissions).toBe(0);
      h.editor.handleInput("\x1f");
      expect(h.editor.getText()).toBe("加一个");
    });
  }

  test("uses the injected keybindings for acceptance", () => {
    const h = harness("continue");
    h.keybindings.setUserBindings({ "tui.input.tab": "ctrl+t" });
    h.editor.handleInput("\x14");
    expect(h.editor.getText()).toBe("continue");
    expect(h.accepted).toBe(1);
  });

  test("matching prefixes remain visible and diverging input clears predictions", () => {
    const h = harness();
    h.editor.handleInput("加");
    expect(h.editor.render(60).join("\n")).toContain("中文回归测试");
    h.editor.handleInput("错");
    expect(h.editor.render(60).join("\n")).not.toContain("中文回归测试");
    h.editor.handleInput("\x1b[C");
    expect(h.editor.getText()).toBe("加错");
    expect(h.accepted).toBe(0);
  });

  test("does not steal navigation or autocomplete keys", () => {
    const h = harness();
    h.editor.setText("加一个");
    h.editor.handleInput("\x1b[D");
    expect(h.editor.render(60).join("\n")).not.toContain("中文回归测试");
    h.editor.handleInput("\x1b[C");
    expect(h.accepted).toBe(0);
    const autocomplete = h.editor.isShowingAutocomplete;
    h.editor.isShowingAutocomplete = () => true;
    expect(h.editor.render(60).join("\n")).not.toContain("中文回归测试");
    h.editor.handleInput("\x1b[C");
    expect(h.accepted).toBe(0);
    h.editor.isShowingAutocomplete = autocomplete;
  });

  test("Escape dismisses once and then preserves the editor's interrupt handler", () => {
    const h = harness();
    let escapes = 0;
    h.editor.onEscape = () => { escapes++; };
    h.editor.handleInput("\x1b");
    expect(h.cancelled).toBe(1);
    expect(escapes).toBe(0);
    h.editor.handleInput("\x1b");
    expect(escapes).toBe(1);
  });

  test("never interprets split bracketed paste as prediction acceptance", () => {
    const h = harness();
    h.editor.handleInput("\x1b[200~");
    h.editor.handleInput("\t");
    h.editor.handleInput("\x1b[201~");
    expect(h.accepted).toBe(0);
    expect(h.editor.getText()).toBe("    ");
  });

  test("clips Chinese and emoji previews within the available columns at every width", () => {
    const h = harness("👩‍💻中文预测".repeat(20));
    for (const padding of [0, 2]) {
      h.editor.setPaddingX(padding);
      for (const width of [1, 2, 3, 4, 8, 20, 80]) {
        const lines = h.editor.render(width);
        expect(lines.map(line => visibleWidth(line)), JSON.stringify({ padding, width, lines })).toEqual(lines.map(() => width));
        expect(h.editor.getText()).toBe("");
      }
    }
    h.editor.handleInput("\t");
    expect(h.editor.getText()).toBe("👩‍💻中文预测".repeat(20));
  });

  test("does not show an unfocused preview or alter later editor extensions on disposal", () => {
    const h = harness();
    h.editor.focused = false;
    expect(h.editor.render(60).join("\n")).not.toContain("中文回归测试");
    h.editor.focused = true;
    const ours = h.editor.render;
    const laterRender = (width: number) => ours.call(h.editor, width);
    h.editor.render = laterRender;
    h.binding.dispose();
    expect(h.editor.render).toBe(laterRender);
    expect(h.editor.handleInput).toBe(h.originalInput);
    expect(h.editor.render(60).join("\n")).not.toContain("中文回归测试");
    expect(h.ui.getEditorComponent()).toBe(h.previous);
  });
});
