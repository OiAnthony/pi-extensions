import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { PredictionEditorHooks } from "./editor.js";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Add a display-only preview while keeping the existing editor and its undo stack. */
export function installPiPredictions(
  editor: ReturnType<EditorFactory>,
  theme: () => ExtensionContext["ui"]["theme"],
  keybindings: Parameters<EditorFactory>[2],
  hooks: PredictionEditorHooks,
): () => void {
  const cursorEditor = editor as typeof editor & Partial<Pick<CustomEditor, "focused" | "getCursor" | "getPaddingX" | "isShowingAutocomplete">>;
  const originalRender = editor.render;
  const originalInput = editor.handleInput;
  const renderDescriptor = Object.getOwnPropertyDescriptor(editor, "render");
  const inputDescriptor = Object.getOwnPropertyDescriptor(editor, "handleInput");
  let disposed = false;
  let pasting = false;

  const predictionSuffix = (): string | undefined => {
    if (disposed || pasting || !cursorEditor.focused || !cursorEditor.isShowingAutocomplete || cursorEditor.isShowingAutocomplete()) return;
    if (!editor.insertTextAtCursor) return;
    const text = editor.getText();
    const cursor = cursorEditor.getCursor?.();
    const choice = hooks.choices()?.[0];
    if (!choice || !cursor || text.includes("\n") || cursor.line !== 0 || cursor.col !== text.length || !choice.startsWith(text)) return;
    return choice.slice(text.length) || undefined;
  };
  const suffix = (): string | undefined => predictionSuffix() ?? hooks.status?.();

  const render: typeof editor.render = function (this: typeof editor, width) {
    const lines = originalRender.call(this, width);
    const remaining = suffix();
    if (!remaining) return lines;
    const row = lines.findIndex(line => line.includes(CURSOR_MARKER));
    if (row < 0) return lines;
    const line = lines[row]!;
    const before = line.slice(0, line.indexOf(CURSOR_MARKER));
    const column = visibleWidth(before);
    const padding = Math.min(cursorEditor.getPaddingX?.() ?? 0, Math.max(0, Math.floor((width - 1) / 2)));
    const available = Math.max(0, width - padding - column);
    const preview = visibleWidth(remaining) <= available ? remaining
      : available > 0 ? sliceByColumn(remaining, 0, available - 1, true) + "…" : "";
    const first = graphemes.segment(preview)[Symbol.iterator]().next().value?.segment;
    if (!first) return lines;
    const end = column + visibleWidth(preview);
    const result = [...lines];
    result[row] = before + CURSOR_MARKER
      + theme().fg("dim", theme().inverse(first) + preview.slice(first.length))
      + sliceByColumn(line.replaceAll(CURSOR_MARKER, ""), end, Math.max(0, width - end), true);
    return result;
  };

  const handleInput: typeof editor.handleInput = function (this: typeof editor, data) {
    const wasPasting = pasting;
    if (data.includes("\x1b[200~")) pasting = true;
    const pasteInput = wasPasting || pasting;
    if (data.includes("\x1b[201~")) pasting = false;
    if (!disposed && !pasteInput) {
      const remaining = predictionSuffix();
      if (keybindings.matches(data, "app.interrupt")) {
        hooks.cancelled();
        if (remaining) return;
      }
      if (remaining && (keybindings.matches(data, "tui.input.tab") || keybindings.matches(data, "tui.editor.cursorRight"))) {
        this.insertTextAtCursor!(remaining);
        hooks.accepted();
        return;
      }
    }
    originalInput.call(this, data);
  };

  editor.render = render;
  editor.handleInput = handleInput;
  return () => {
    disposed = true;
    if (editor.render === render) {
      if (renderDescriptor) Object.defineProperty(editor, "render", renderDescriptor);
      else Reflect.deleteProperty(editor, "render");
    }
    if (editor.handleInput === handleInput) {
      if (inputDescriptor) Object.defineProperty(editor, "handleInput", inputDescriptor);
      else Reflect.deleteProperty(editor, "handleInput");
    }
  };
}
