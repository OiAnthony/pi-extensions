import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
export const ROLE_WIDGET_DURATION_MS = 3_000;
export const ROLE_WIDGET_PADDING_X = 1;
export const ROLE_WIDGET_GAP_LINES = 1;

type HostModel = NonNullable<ExtensionContext["model"]>;
type ShortcutContext = ExtensionContext;
type RoleStatusTheme = ShortcutContext["ui"]["theme"];

export interface RoleCandidate<Model extends ModelLike = HostModel> {
  name: string;
  resolution: ResolvedModelTarget<Model>;
}

export interface SettingsTextIO {
  readTextFile(path: string): string | undefined;
  writeTextFile(path: string, content: string): void;
}

export interface RoleExtensionDependencies {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  settingsIO?: SettingsTextIO;
  globalSettingsPath?: string;
  projectSettingsPathFor?(cwd: string): string;
  processArgs?: readonly string[];
  hasPiProcessMarker?(): boolean;
}

const defaultDependencies: RoleExtensionDependencies = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

const MODEL_ROLES_PACKAGE_ID = "pi-model-roles";
const POWERLINE_FOOTER_PACKAGE_ID = "pi-powerline-footer";

const defaultSettingsIO: SettingsTextIO = {
  readTextFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeTextFile(path, content) {
    writeFileSync(path, content);
  },
};

export function packageEntrySource(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    const source = entry.trim();
    return source || undefined;
  }
  if (entry && typeof entry === "object" && "source" in entry) {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === "string") {
      const trimmed = source.trim();
      return trimmed || undefined;
    }
  }
  return undefined;
}

export function packageSourceIdentity(source: string): string {
  let rest = source.trim().replaceAll("\\", "/");
  if (rest.startsWith("npm:")) rest = rest.slice(4);
  else if (rest.startsWith("git:")) rest = rest.slice(4);
  const last = rest.split("/").filter(Boolean).at(-1) ?? rest;
  return last.replace(/@[^@]+$/, "").toLowerCase();
}

export function planPackagesBeforePowerline(packages: readonly unknown[]): unknown[] | undefined {
  let rolesIndex = -1;
  let powerlineIndex = -1;
  for (const [index, entry] of packages.entries()) {
    const source = packageEntrySource(entry);
    if (!source) continue;
    const identity = packageSourceIdentity(source);
    if (rolesIndex < 0 && identity === MODEL_ROLES_PACKAGE_ID) rolesIndex = index;
    if (powerlineIndex < 0 && identity === POWERLINE_FOOTER_PACKAGE_ID) powerlineIndex = index;
  }
  if (rolesIndex < 0 || powerlineIndex < 0 || rolesIndex < powerlineIndex) return undefined;

  const next = [...packages];
  const [roles] = next.splice(rolesIndex, 1);
  next.splice(powerlineIndex, 0, roles);
  return next;
}

export function persistModelRolesBeforePowerline(
  paths: readonly string[],
  io: SettingsTextIO,
): string[] {
  const written: string[] = [];
  for (const path of paths) {
    if (persistSettingsPackages(path, io)) written.push(path);
  }
  return written;
}

function persistStartupPackageOrder(
  ctx: ShortcutContext,
  dependencies: RoleExtensionDependencies,
): void {
  const io = dependencies.settingsIO ?? defaultSettingsIO;
  const paths = [dependencies.globalSettingsPath ?? join(getAgentDir(), "settings.json")];
  if (ctx.isProjectTrusted()) {
    paths.push(dependencies.projectSettingsPathFor?.(ctx.cwd) ?? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
  }
  persistModelRolesBeforePowerline(paths, io);
}

function persistSettingsPackages(path: string, io: SettingsTextIO): boolean {
  const text = io.readTextFile(path);
  if (text === undefined) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;

  const settings = parsed as { packages?: unknown };
  if (!Array.isArray(settings.packages)) return false;

  const packages = planPackagesBeforePowerline(settings.packages);
  if (!packages) return false;

  try {
    io.writeTextFile(path, `${JSON.stringify({ ...settings, packages }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

interface SettingsValue {
  present: boolean;
  value?: unknown;
}

function readSettingsValue(path: string, key: string, io: SettingsTextIO): SettingsValue {
  const text = io.readTextFile(path);
  if (text === undefined) return { present: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return { present: false };
    return { present: true, value: (parsed as Record<string, unknown>)[key] };
  } catch {
    return { present: false };
  }
}

function configuredDefaultRole(
  ctx: ShortcutContext,
  dependencies: RoleExtensionDependencies,
): string | undefined {
  const io = dependencies.settingsIO ?? defaultSettingsIO;
  const globalPath = dependencies.globalSettingsPath ?? join(getAgentDir(), "settings.json");
  let configured = readSettingsValue(globalPath, "defaultModel", io);
  if (ctx.isProjectTrusted()) {
    const projectPath = dependencies.projectSettingsPathFor?.(ctx.cwd) ?? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
    const projectConfigured = readSettingsValue(projectPath, "defaultModel", io);
    if (projectConfigured.present) configured = projectConfigured;
  }
  if (typeof configured.value !== "string") return undefined;
  const target = configured.value.trim();
  return target.startsWith("@") ? target : undefined;
}

function hasCliOption(args: readonly string[], option: string): boolean {
  return args.includes(option);
}

function hasConversation(ctx: ShortcutContext): boolean {
  return ctx.sessionManager.buildContextEntries().some((entry) => (
    entry.type === "message"
    || entry.type === "custom_message"
    || entry.type === "compaction"
    || entry.type === "branch_summary"
  ));
}

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

const ROLE_TRACK_COLORS: ReadonlyArray<Parameters<RoleStatusTheme["fg"]>[0]> = [
  "accent",
  "success",
  "warning",
  "error",
  "mdCode",
  "mdLink",
];
const ROLE_TRACK_CAP_LEFT = "";
const ROLE_TRACK_CAP_RIGHT = "";
const ROLE_TRACK_SEPARATOR = "";
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";

function roleStatusText(
  theme: RoleStatusTheme,
  candidates: readonly RoleCandidate[],
  activeName: string,
): string {
  let track = "";
  candidates.forEach((candidate, index) => {
    const active = candidate.name === activeName;
    if (index > 0) {
      const previousActive = candidates[index - 1]?.name === activeName;
      track += active || previousActive ? "  " : ` ${theme.fg("dim", ROLE_TRACK_SEPARATOR)} `;
    }

    const color = ROLE_TRACK_COLORS[index % ROLE_TRACK_COLORS.length]!;
    if (!active) {
      track += theme.fg(color, candidate.name);
      return;
    }

    const chip = `${ROLE_TRACK_CAP_LEFT}${REVERSE_ON} ${theme.bold(candidate.name)} ${REVERSE_OFF}${ROLE_TRACK_CAP_RIGHT}`;
    track += theme.fg(color, chip);
  });
  return track;
}

export default function register(
  pi: ExtensionAPI,
  config: ModelRolesConfig = loadModelRoles(),
  dependencies: RoleExtensionDependencies = defaultDependencies,
): void {
  let clearWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let switching = false;
  let active: { name: string; modelId: string; thinkingLevel: ThinkingLevel } | undefined;
  let roleTrack: { candidates: readonly RoleCandidate[]; activeName: string } | undefined;
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
          const track = truncateToWidth(
            roleStatusText(theme, roleTrack.candidates, roleTrack.activeName),
            contentWidth,
            "",
          );
          return [
            `${" ".repeat(ROLE_WIDGET_PADDING_X)}${track}`,
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
  ): void => {
    installWidget(ctx);
    if (clearWidgetTimer) dependencies.clearTimer(clearWidgetTimer);
    roleTrack = { candidates, activeName };
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
      showRoleTrack(ctx, candidates, selected.name);
    } catch {
      ctx.ui.notify("Unable to switch model roles.", "error");
    } finally {
      switching = false;
    }
  };

  const applyDefaultRole = async (
    event: { reason: "startup" | "reload" | "new" | "resume" | "fork" },
    ctx: ShortcutContext,
  ): Promise<void> => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    const hasPiProcessMarker = dependencies.hasPiProcessMarker?.() ?? process.env.PI_CODING_AGENT === "true";
    if (!hasPiProcessMarker) return;
    if (hasConversation(ctx) || ctx.scopedModels.length > 0) return;
    const processArgs = dependencies.processArgs ?? process.argv.slice(1);
    if (hasCliOption(processArgs, "--model")) return;

    const target = configuredDefaultRole(ctx, dependencies);
    if (!target) return;
    const resolution = await resolveModelTarget({
      target,
      currentModel: ctx.model,
      modelRegistry: ctx.modelRegistry as unknown as ModelRegistryLike<HostModel>,
      config,
      allowCurrentFallback: false,
    });
    if (!isResolvedModelTarget(resolution)) {
      const reason = resolution.issues.at(-1)?.message ?? "The role could not be resolved.";
      ctx.ui.notify(`Unable to apply default model role ${target}: ${reason}`, "error");
      return;
    }
    if (!await pi.setModel(resolution.model)) {
      ctx.ui.notify(`Unable to apply default model role ${target}.`, "error");
      return;
    }
    if (resolution.thinkingLevel !== undefined && !hasCliOption(processArgs, "--thinking")) {
      pi.setThinkingLevel(resolution.thinkingLevel);
    }
    active = {
      name: resolution.role ?? target.slice(1),
      modelId: resolution.modelId,
      thinkingLevel: pi.getThinkingLevel(),
    };
  };

  pi.registerShortcut("ctrl+p", {
    description: "Cycle to the next model role",
    handler: async (ctx) => cycle(ctx, 1),
  });
  pi.registerShortcut("ctrl+shift+p", {
    description: "Cycle to the previous model role",
    handler: async (ctx) => cycle(ctx, -1),
  });
  pi.on("session_start", async (event, ctx) => {
    active = undefined;
    hideRoleTrack();
    try {
      persistStartupPackageOrder(ctx, dependencies);
    } catch {
      // Keep session startup intact if settings I/O fails.
    }
    installWidget(ctx);
    try {
      await applyDefaultRole(event, ctx);
    } catch {
      ctx.ui.notify("Unable to apply the default model role.", "error");
    }
  });
  pi.on("session_shutdown", (_event, ctx) => removeWidget(ctx));
}

export * from "../library/index.js";
