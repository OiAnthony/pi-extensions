import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PredictionEditorHooks {
  choices(): readonly string[] | undefined;
  accepted(): void;
  draftChanged(text: string): void;
}

export interface PredictionEditorBinding {
  requestRender(): void;
  dispose(): void;
}

type EditorUI = Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
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

    intercept("predictions", read => () => {
      const choices = disposed ? undefined : hooks.choices();
      extensionPrediction = !!choices?.length;
      return extensionPrediction ? choices : read()?.call(native);
    });
    intercept("onPredictionAccepted", read => index => {
      // Attribution follows the provider actually used by the native editor,
      // not hooks.choices() after native insertion has already changed the draft.
      if (!disposed && extensionPrediction) hooks.accepted();
      else read()?.call(native, index);
    });
    intercept("onPredictionShown", read => () => {
      if (disposed || !extensionPrediction) read()?.call(native);
    });

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
