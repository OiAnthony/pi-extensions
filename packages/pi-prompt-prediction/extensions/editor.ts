import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPiPredictions } from "./pi-editor.js";
import { CURSOR_MARKER, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

export interface PredictionEditorHooks {
  choices(): readonly string[] | undefined;
  accepted(): void;
  cancelled(): void;
  draftChanged(text: string): void;
  status?(): string | undefined;
}

export interface PredictionEditorBinding {
  requestRender(): void;
  dispose(): void;
}

type EditorUI = Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent" | "theme">;
type EditorFactory = NonNullable<Parameters<EditorUI["setEditorComponent"]>[0]>;

// OMP provides these fields natively; the installed Pi peer types do not yet expose them.
interface NativePredictions {
  predictions?: () => readonly string[] | undefined;
  onPredictionAccepted?: (index: number) => void;
  onPredictionShown?: () => void;
  onChange?: (text: string) => void;
}

export function installPredictionEditor(
  ui: EditorUI,
  hooks: PredictionEditorHooks,
  runtime: "pi" | "omp" = "omp",
): PredictionEditorBinding {
  const previousFactory = ui.getEditorComponent();
  const cleanups = new Map<object, () => void>();
  let render: (() => void) | undefined;
  let disposed = false;

  const factory: EditorFactory = (tui, theme, keybindings) => {
    const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    if (disposed) return editor;
    render = () => tui.requestRender();
    if (cleanups.has(editor)) return editor;

    const native = editor as typeof editor & NativePredictions;
    const restore: (() => void)[] = [];
    let extensionPrediction = false;
    let extensionStatus = false;

    if (runtime === "omp") {
      let hostHandleInput = editor.handleInput;
      const handleInputDescriptor = Object.getOwnPropertyDescriptor(editor, "handleInput");
      const handleInputWithStatus: typeof editor.handleInput = function (this: typeof editor, data) {
        if (extensionStatus && (keybindings.matches(data, "tui.input.tab") || keybindings.matches(data, "tui.editor.cursorRight"))) return;
        return hostHandleInput.call(this, data);
      };
      const getHandleInput = () => handleInputWithStatus;
      Object.defineProperty(editor, "handleInput", {
        configurable: true,
        enumerable: handleInputDescriptor?.enumerable ?? true,
        get: getHandleInput,
        set: (next: typeof editor.handleInput) => { hostHandleInput = next; },
      });
      restore.push(() => {
        if (Object.getOwnPropertyDescriptor(editor, "handleInput")?.get !== getHandleInput) return;
        if (handleInputDescriptor) Object.defineProperty(editor, "handleInput", handleInputDescriptor);
        else Object.defineProperty(editor, "handleInput", { configurable: true, writable: true, value: hostHandleInput });
      });
    }

    if (runtime === "omp") {
      let hostRender = editor.render;
      const renderDescriptor = Object.getOwnPropertyDescriptor(editor, "render");
      const renderWithStatus: typeof editor.render = function (this: typeof editor, width) {
        const lines = hostRender.call(this, width);
        const status = hooks.status?.();
        if (!status || editor.getText() !== "") return lines;
        const row = lines.findIndex(line => line.includes(CURSOR_MARKER));
        if (row < 0) return lines;
        const line = lines[row]!;
        const before = line.slice(0, line.indexOf(CURSOR_MARKER));
        const column = visibleWidth(before);
        const available = Math.max(0, width - column);
        const preview = available > 0 ? sliceByColumn(status, 0, available, true) : "";
        if (!preview) return lines;
        const result = [...lines];
        const end = column + visibleWidth(preview);
        result[row] = before + CURSOR_MARKER + ui.theme.fg("dim", preview)
          + sliceByColumn(line.replaceAll(CURSOR_MARKER, ""), end, Math.max(0, width - end), true);
        return result;
      };
      const getRender = () => renderWithStatus;
      Object.defineProperty(editor, "render", {
        configurable: true,
        enumerable: renderDescriptor?.enumerable ?? true,
        get: getRender,
        set: (next: typeof editor.render) => { hostRender = next; },
      });
      restore.push(() => {
        if (Object.getOwnPropertyDescriptor(editor, "render")?.get !== getRender) return;
        if (renderDescriptor) Object.defineProperty(editor, "render", renderDescriptor);
        else Object.defineProperty(editor, "render", { configurable: true, writable: true, value: hostRender });
      });
    }

    // The host assigns callbacks AFTER this factory returns. Accessors keep
    // our multiplexers installed while retaining the host's latest assignments.
    function intercept<K extends keyof NativePredictions>(
      key: K,
      wrap: (read: () => NativePredictions[K]) => NonNullable<NativePredictions[K]>,
    ): void {
      const descriptor = Object.getOwnPropertyDescriptor(native, key);
      let value: NativePredictions[K] = native[key];
      const read = () => value;
      const wrapped = wrap(read);
      const get = () => wrapped;
      Object.defineProperty(native, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get,
        set(next: NativePredictions[K]) {
          if (descriptor?.set) {
            descriptor.set.call(native, next);
            value = descriptor.get ? descriptor.get.call(native) : next;
          } else {
            value = next;
          }
        },
      });
      restore.push(() => {
        if (Object.getOwnPropertyDescriptor(native, key)?.get !== get) return;
        if (descriptor && !("value" in descriptor)) {
          Object.defineProperty(native, key, descriptor);
        } else {
          Object.defineProperty(native, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            ...descriptor,
            value,
          });
        }
      });
    }

    if (runtime === "omp") {
      intercept("predictions", read => () => {
        const choices = disposed ? undefined : hooks.choices();
        if (choices?.length) {
          extensionStatus = false;
          extensionPrediction = true;
          return choices;
        }
        const status = disposed ? undefined : hooks.status?.();
        extensionPrediction = false;
        extensionStatus = status !== undefined;
        return status ? [status] : read()?.call(native);
      });
      intercept("onPredictionAccepted", read => index => {
        if (extensionStatus) {
          extensionStatus = false;
          return;
        }
        if (!disposed && extensionPrediction) hooks.accepted();
        else read()?.call(native, index);
      });
      intercept("onPredictionShown", read => () => {
        if (disposed || (!extensionPrediction && !extensionStatus)) read()?.call(native);
      });
    } else {
      restore.push(installPiPredictions(editor, () => ui.theme, keybindings, hooks));
    }

    let lastText = editor.getText();
    intercept("onChange", read => text => {
      read()?.call(native, text);
      const currentText = editor.getText();
      if (!disposed && currentText !== lastText) {
        lastText = currentText;
        hooks.draftChanged(currentText);
      }
    });
    cleanups.set(editor, () => {
      for (const cleanup of restore.reverse()) cleanup();
    });
    return editor;
  };

  ui.setEditorComponent(factory);
  return {
    requestRender() {
      if (!disposed) render?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
      render = undefined;
      // Another extension may have replaced or composed our factory meanwhile.
      if (ui.getEditorComponent() === factory) ui.setEditorComponent(previousFactory);
    },
  };
}
