import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  installOmpPredictionComposer,
  installPiPredictionEditor,
  type OmpPredictionUI,
  type PredictionEditorBinding,
} from "./editor.js";
import { PromptPredictionController, type PredictionContext, type PredictionDependencies } from "./prediction.js";

type OmpContext = ExtensionContext & PredictionContext & {
  agent?: { kind: "main" | "sub" };
};

const isPromptPredictInput = (text: string): boolean => /^\/?prompt-predict(?:\s+.*)?$/.test(text.trim());

export default function register(pi: ExtensionAPI, dependencies?: PredictionDependencies): void {
  let editor: PredictionEditorBinding | undefined;
  let scheduled: Timer | undefined;
  let sessionGeneration = 0;
  const controller = new PromptPredictionController(
    () => editor?.requestRender(),
    dependencies,
    () => editor?.requestRender(),
  );
  pi.registerCommand("prompt-predict", {
    description: "Predict the next prompt",
    getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
      const value = prefix.trim();
      return "refresh".startsWith(value) ? [{ value: "refresh", label: "refresh" }] : null;
    },
    handler: async (args, context) => {
      if (controller.isPending) return;
      const refresh = args.trim() === "refresh";
      const deferred = Promise.withResolvers<void>();
      setTimeout(deferred.resolve, 0);
      await deferred.promise;
      if (controller.hasPrediction && !refresh) return;
      if (refresh) controller.cancel();
      await controller.request(context as OmpContext);
    },
  });

  const clearScheduled = (): void => {
    clearTimeout(scheduled);
    scheduled = undefined;
  };
  const cancel = (): void => {
    clearScheduled();
    controller.cancel();
  };

  pi.on("session_start", async (_event, context) => {
    const generation = ++sessionGeneration;
    cancel();
    editor?.dispose();
    editor = undefined;
    const omp = context as OmpContext;
    if (!omp.hasUI || omp.mode !== "tui" || (omp.agent && omp.agent.kind !== "main")) return;
    const hooks = {
      choices: () => controller.choices,
      status: () => controller.status === "predicting" ? "Predicting next prompt…" : undefined,
      accepted: () => {
        clearScheduled();
        controller.draftChanged(omp.ui.getEditorText());
      },
      cancelled: cancel,
      draftChanged: (text: string) => {
        clearScheduled();
        if (isPromptPredictInput(text)) return;
        controller.draftChanged(text);
      },
    };
    if (omp.agent) {
      editor = installOmpPredictionComposer(omp.ui as unknown as OmpPredictionUI, hooks);
      return;
    }
    const binding = await installPiPredictionEditor(omp.ui, hooks);
    if (generation !== sessionGeneration) {
      binding.dispose();
      return;
    }
    editor = binding;
  });

  const schedule = (context: OmpContext): void => {
    // Defer past the host's final idle-state transition and other event handlers.
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void controller.request(context);
    }, 0);
  };

  pi.on("agent_end", (event, context) => {
    cancel();
    const omp = context as OmpContext;
    const willContinue = "willContinue" in event && event.willContinue === true;
    if (!editor || !omp.hasUI || omp.mode !== "tui" || omp.agent?.kind !== "main" || willContinue) return;
    schedule(omp);
  });

  pi.on("agent_settled", (_event, context) => {
    const omp = context as OmpContext;
    if (omp.agent) return;
    cancel();
    if (editor && omp.hasUI && omp.mode === "tui") schedule(omp);
  });

  pi.on("input", (event) => {
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (text.startsWith("/") || isPromptPredictInput(text)) return;
    cancel();
  });
  pi.on("agent_start", cancel);
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_before_compact", cancel);
  pi.on("model_select", cancel);
  pi.on("session_shutdown", () => {
    sessionGeneration++;
    cancel();
    editor?.dispose();
    editor = undefined;
  });
}
