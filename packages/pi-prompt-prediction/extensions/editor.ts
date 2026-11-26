import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export type PiEditorUI = Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent" | "theme">;

export interface OmpComposerKey {
  id: string;
}

export interface OmpComposer {
  addKeyHandler(handler: (key: OmpComposerKey) => boolean): () => void;
  addDecorator(
    decorator: (text: string) => ReadonlyArray<{ from: number; to: number; s: string }>,
  ): () => void;
}

export interface OmpWidgetTheme {
  fg(color: "accent" | "dim" | "muted", text: string): string;
}

export interface OmpWidgetTui {
  requestRender?(): void;
}

export interface OmpWidgetRows {
  render(width: number): string[];
  invalidate(): void;
}

export type OmpWidgetFactory = (ui: OmpWidgetTui | undefined, theme: OmpWidgetTheme) => OmpWidgetRows;
export interface OmpPredictionUI {
  composer?: OmpComposer;
  theme: OmpWidgetTheme;
  getEditorText(): string;
  setEditorText(text: string): void;
  setWidget(
    key: string,
    content: string[] | OmpWidgetFactory | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export const PREDICTION_WIDGET_KEY = "pi-prompt-prediction";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDE_CODEPOINT = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

function graphemeWidth(segment: string): number {
  return WIDE_CODEPOINT.test(segment) ? 2 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += graphemeWidth(segment);
  return width;
}

function truncateDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = graphemeWidth(segment);
    if (used + w > maxWidth - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

function stylePredictionBody(visibleChoice: string, draft: string, theme: OmpWidgetTheme): string {
  if (!visibleChoice) return "";
  if (!draft) return theme.fg("muted", visibleChoice);
  if (!visibleChoice.startsWith(draft)) return theme.fg("dim", visibleChoice);
  const remaining = visibleChoice.slice(draft.length);
  return remaining
    ? theme.fg("dim", draft) + theme.fg("muted", remaining)
    : theme.fg("dim", draft);
}

function renderPredictionLine(choice: string, draft: string, width: number, theme: OmpWidgetTheme): string {
  if (width <= 0) return "";
  const prefix = " ↳ ";
  const prefixWidth = displayWidth(prefix);
  if (width <= prefixWidth) return theme.fg("muted", truncateDisplay(`${prefix}${choice}`, width));
  const hint = draft.length === 0 ? "  [Tab / →]" : "  [Tab]";
  const budget = width - prefixWidth - displayWidth(hint);
  if (budget < 4) {
    const visibleChoice = truncateDisplay(choice, width - prefixWidth);
    return theme.fg("accent", prefix) + stylePredictionBody(visibleChoice, draft, theme);
  }
  const visibleChoice = truncateDisplay(choice, budget);
  return theme.fg("accent", prefix) + stylePredictionBody(visibleChoice, draft, theme) + theme.fg("dim", hint);
}

function renderStatusLine(status: string, width: number, theme: OmpWidgetTheme): string {
  if (width <= 0) return "";
  const prefix = " ↳ ";
  const prefixWidth = displayWidth(prefix);
  if (width <= prefixWidth) return theme.fg("dim", truncateDisplay(`${prefix}${status}`, width));
  return theme.fg("accent", prefix) + theme.fg("dim", truncateDisplay(status, width - prefixWidth));
}

export function installOmpPredictionComposer(
  ui: OmpPredictionUI,
  hooks: PredictionEditorHooks,
): PredictionEditorBinding {
  const composer = ui.composer;
  if (!composer) {
    return { requestRender() {}, dispose() {} };
  }

  let disposed = false;
  let widgetMounted = false;
  let widgetTui: OmpWidgetTui | undefined;
  let lastText = ui.getEditorText();

  const activeChoice = (text: string): string | undefined => {
    if (disposed || text.includes("\n")) return undefined;
    const choice = hooks.choices()?.[0];
    if (!choice || !choice.startsWith(text) || choice.length <= text.length) return undefined;
    return choice;
  };

  const activeStatus = (text: string): string | undefined => {
    if (disposed || text !== "") return undefined;
    return hooks.status?.();
  };

  let renderedText = lastText;
  let renderedChoice = activeChoice(lastText);
  let renderedStatus = renderedChoice ? undefined : activeStatus(lastText);

  const mountWidget = (): void => {
    widgetMounted = true;
    ui.setWidget(
      PREDICTION_WIDGET_KEY,
      (tui, theme) => {
        widgetTui = tui;
        return {
          render(width: number): string[] {
            if (width <= 0) return [];
            const resolvedTheme = theme ?? ui.theme;
            const line = renderedChoice
              ? renderPredictionLine(renderedChoice, renderedText, width, resolvedTheme)
              : renderedStatus
                ? renderStatusLine(renderedStatus, width, resolvedTheme)
                : "";
            // Keep one blank row below the prediction so it clears OMP/Tern's top composer badges (e.g. context %, fallback).
            return line ? [line, " "] : [];
          },
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );
  };

  const unmountWidget = (): void => {
    if (!widgetMounted) return;
    widgetMounted = false;
    widgetTui = undefined;
    ui.setWidget(PREDICTION_WIDGET_KEY, undefined);
  };

  const syncWidget = (text: string): void => {
    renderedText = text;
    renderedChoice = activeChoice(text);
    renderedStatus = renderedChoice ? undefined : activeStatus(text);
    if (!renderedChoice && !renderedStatus) {
      unmountWidget();
      return;
    }
    if (widgetMounted && widgetTui?.requestRender) {
      widgetTui.requestRender();
      return;
    }
    mountWidget();
  };
  const removeDecorator = composer.addDecorator((text) => {
    if (disposed) return [];
    if (text !== lastText) {
      lastText = text;
      hooks.draftChanged(text);
      syncWidget(text);
    }
    return [];
  });

  const removeKeyHandler = composer.addKeyHandler((key) => {
    if (disposed) return false;
    const text = ui.getEditorText();
    const choice = activeChoice(text);
    if (!choice) return false;
    if (key.id === "escape") {
      hooks.cancelled();
      syncWidget(text);
      return true;
    }
    if (key.id === "tab" || (text === "" && key.id === "right")) {
      lastText = choice;
      ui.setEditorText(choice);
      hooks.accepted();
      syncWidget(choice);
      return true;
    }
    return false;
  });

  return {
    requestRender() {
      if (!disposed) syncWidget(ui.getEditorText());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeKeyHandler();
      removeDecorator();
      unmountWidget();
    },
  };
}

export async function installPiPredictionEditor(
  ui: PiEditorUI,
  hooks: PredictionEditorHooks,
): Promise<PredictionEditorBinding> {
  // Keep specifier non-literal so OMP 19.x does not statically traverse pi-editor.ts (which imports @earendil-works/pi-tui).
  const specifier = "./pi-editor" + ".js";
  const mod = (await import(specifier)) as {
    installPiPredictionEditor(ui: PiEditorUI, hooks: PredictionEditorHooks): PredictionEditorBinding;
  };
  return mod.installPiPredictionEditor(ui, hooks);
}
