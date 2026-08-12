import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  isResolvedModelTarget,
  loadModelRoles,
  resolveModelTarget,
  type ModelLike,
  type ModelRegistryLike,
  type ModelRolesConfig,
  type ResolvedModelTarget,
  type ThinkingLevel,
} from "../library/index.js";

export const ROLE_WIDGET_ID = "pi-model-roles-track";
export const ROLE_WIDGET_DURATION_MS = 1_500;
export const ROLE_WIDGET_PADDING_X = 1;
export const ROLE_WIDGET_GAP_LINES = 1;

type HostModel = NonNullable<ExtensionContext["model"]>;
type ShortcutContext = ExtensionContext;
type RoleTrackTheme = ShortcutContext["ui"]["theme"];

export interface RoleCandidate<Model extends ModelLike = HostModel> {
  name: string;
  resolution: ResolvedModelTarget<Model>;
}

export interface RoleExtensionDependencies {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const defaultDependencies: RoleExtensionDependencies = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

function modelKey(model: ModelLike | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export async function resolveRoleCandidates<Model extends ModelLike>(
  config: ModelRolesConfig,
  currentModel: Model | undefined,
  modelRegistry: ModelRegistryLike<Model>,
): Promise<RoleCandidate<Model>[]> {
  const candidates: RoleCandidate<Model>[] = [];
  for (const name of config.cycleOrder) {
    const resolution = await resolveModelTarget({
      target: `@${name}`,
      currentModel,
      modelRegistry,
      config,
      allowCurrentFallback: false,
    });
    if (isResolvedModelTarget(resolution) && !resolution.fallback) {
      candidates.push({ name, resolution });
    }
  }
  return candidates;
}

function currentCandidateIndex<Model extends ModelLike>(
  candidates: readonly RoleCandidate<Model>[],
  currentModel: Model | undefined,
  currentThinking: ThinkingLevel,
  active: { name: string; modelId: string; thinkingLevel: ThinkingLevel } | undefined,
): number {
  const currentModelId = modelKey(currentModel);
  if (active && active.modelId === currentModelId && active.thinkingLevel === currentThinking) {
    const activeIndex = candidates.findIndex((candidate) => candidate.name === active.name);
    if (activeIndex >= 0) return activeIndex;
  }
  return candidates.findIndex((candidate) => (
    candidate.resolution.modelId === currentModelId
    && (candidate.resolution.thinkingLevel === undefined || candidate.resolution.thinkingLevel === currentThinking)
  ));
}

export function nextRoleIndex(currentIndex: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : count - 1;
  return (currentIndex + direction + count) % count;
}

function roleTrackLine(
  theme: RoleTrackTheme,
  candidates: readonly RoleCandidate[],
  activeName: string,
  finalThinking: ThinkingLevel,
): string {
  const items = candidates.map((candidate) => {
    const label = candidate.name === activeName ? `[${candidate.name}]` : candidate.name;
    return candidate.name === activeName ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
  });
  return `${items.join(theme.fg("dim", "  "))} ${theme.fg("dim", `(${finalThinking})`)}`;
}

export default function register(
  pi: ExtensionAPI,
  config: ModelRolesConfig = loadModelRoles(),
  dependencies: RoleExtensionDependencies = defaultDependencies,
): void {
  let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let switching = false;
  let active: { name: string; modelId: string; thinkingLevel: ThinkingLevel } | undefined;
  let roleTrack: {
    candidates: readonly RoleCandidate[];
    activeName: string;
    finalThinking: ThinkingLevel;
  } | undefined;
  let widgetInstalled = false;
  let requestWidgetRender: (() => void) | undefined;

  const hideRoleTrack = (): void => {
    if (clearWidgetTimer) dependencies.clearTimer(clearWidgetTimer);
    clearWidgetTimer = undefined;
    roleTrack = undefined;
    requestWidgetRender?.();
  };

  const removeWidget = (ctx: ShortcutContext): void => {
    hideRoleTrack();
    widgetInstalled = false;
    requestWidgetRender = undefined;
    ctx.ui.setWidget(ROLE_WIDGET_ID, undefined);
  };

  const installWidget = (ctx: ShortcutContext): void => {
    if (widgetInstalled) return;
    widgetInstalled = true;
    ctx.ui.setWidget(ROLE_WIDGET_ID, (tui, theme) => {
      requestWidgetRender = () => tui.requestRender();
      return {
        render(width: number): string[] {
          if (!roleTrack || width <= ROLE_WIDGET_PADDING_X) return [];
          const contentWidth = width - ROLE_WIDGET_PADDING_X;
          const line = truncateToWidth(
            roleTrackLine(theme, roleTrack.candidates, roleTrack.activeName, roleTrack.finalThinking),
            contentWidth,
          );
          return [
            `${" ".repeat(ROLE_WIDGET_PADDING_X)}${line}`,
            ...Array.from({ length: ROLE_WIDGET_GAP_LINES }, () => ""),
          ];
        },
        invalidate() {},
        dispose() {
          requestWidgetRender = undefined;
        },
      };
    }, { placement: "aboveEditor" });
  };

  const showRoleTrack = (
    ctx: ShortcutContext,
    candidates: readonly RoleCandidate[],
    activeName: string,
    finalThinking: ThinkingLevel,
  ): void => {
    installWidget(ctx);
    if (clearWidgetTimer) dependencies.clearTimer(clearWidgetTimer);
    roleTrack = { candidates, activeName, finalThinking };
    requestWidgetRender?.();
    clearWidgetTimer = dependencies.setTimer(() => {
      clearWidgetTimer = undefined;
      roleTrack = undefined;
      requestWidgetRender?.();
    }, ROLE_WIDGET_DURATION_MS);
    clearWidgetTimer.unref?.();
  };

  const cycle = async (ctx: ShortcutContext, direction: 1 | -1): Promise<void> => {
    if (switching) return;
    switching = true;
    try {
      const candidates = await resolveRoleCandidates(
        config,
        ctx.model,
        ctx.modelRegistry as unknown as ModelRegistryLike<HostModel>,
      );
      if (candidates.length === 0) {
        ctx.ui.notify("No available model roles are configured.", "error");
        return;
      }

      const currentThinking = pi.getThinkingLevel();
      const currentIndex = currentCandidateIndex(candidates, ctx.model, currentThinking, active);
      const selected = candidates[nextRoleIndex(currentIndex, candidates.length, direction)]!;
      const switched = await pi.setModel(selected.resolution.model);
      if (!switched) {
        ctx.ui.notify(`Unable to switch to model role ${selected.name}.`, "error");
        return;
      }
      if (selected.resolution.thinkingLevel !== undefined) {
        pi.setThinkingLevel(selected.resolution.thinkingLevel);
      }
      const finalThinking = pi.getThinkingLevel();
      active = { name: selected.name, modelId: selected.resolution.modelId, thinkingLevel: finalThinking };
      showRoleTrack(ctx, candidates, selected.name, finalThinking);
    } catch {
      ctx.ui.notify("Unable to switch model roles.", "error");
    } finally {
      switching = false;
    }
  };

  pi.registerShortcut("ctrl+p", {
    description: "Cycle to the next model role",
    handler: async (ctx) => cycle(ctx, 1),
  });
  pi.registerShortcut("ctrl+shift+p", {
    description: "Cycle to the previous model role",
    handler: async (ctx) => cycle(ctx, -1),
  });
  pi.on("session_start", (_event, ctx) => {
    active = undefined;
    hideRoleTrack();
    installWidget(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => removeWidget(ctx));
}

export * from "../library/index.js";
