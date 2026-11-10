import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPredictionEditor, type PredictionEditorBinding } from "./editor.js";
import { PromptPredictionController, type PredictionContext, type PredictionDependencies } from "./prediction.js";

type OmpContext = ExtensionContext & PredictionContext & {
  agent?: { kind: "main" | "sub" };
};

export default function register(pi: ExtensionAPI, dependencies?: PredictionDependencies): void {
  let editor: PredictionEditorBinding | undefined;
  let scheduled: Timer | undefined;
  const controller = new PromptPredictionController(() => editor?.requestRender(), dependencies);

  const clearScheduled = (): void => {
    clearTimeout(scheduled);
    scheduled = undefined;
  };
  const cancel = (): void => {
    clearScheduled();
    controller.cancel();
  };

  pi.on("session_start", (_event, context) => {
    cancel();
    editor?.dispose();
    editor = undefined;
    const omp = context as OmpContext;
    if (!omp.hasUI || omp.mode !== "tui" || omp.agent?.kind !== "main") return;
    editor = installPredictionEditor(omp.ui, {
      choices: () => controller.choices,
      accepted: cancel,
      draftChanged: (text) => {
        clearScheduled();
        controller.draftChanged(text);
      },
    });
  });

  pi.on("agent_end", (event, context) => {
    cancel();
    const omp = context as OmpContext;
    const willContinue = "willContinue" in event && event.willContinue === true;
    if (!editor || !omp.hasUI || omp.mode !== "tui" || omp.agent?.kind !== "main" || willContinue) return;
    // agent_end can precede the host's final idle-state transition.
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void controller.request(omp);
    }, 0);
  });

  pi.on("input", cancel);
  pi.on("agent_start", cancel);
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_before_compact", cancel);
  pi.on("model_select", cancel);
  pi.on("session_shutdown", () => {
    cancel();
    editor?.dispose();
    editor = undefined;
  });
}
