import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  STATE_ENTRY_TYPE,
  buildNamingContext,
  configuredModelLabel,
  createState,
  extractCompletedExchanges,
  loadConfig,
  nextAutomaticEvaluation,
  parseModelReference,
  renderTerminalTitle,
  requestTitle,
  restoreState,
  type NamingContext,
  type SessionTitleConfig,
  type SessionTitleState,
  type TitleDependencies,
} from "./core.js";
import { createHerdrReporter, type HerdrDependencies, type HerdrReporter } from "./herdr.js";

export interface RuntimeDependencies {
  title?: TitleDependencies;
  herdr?: Partial<HerdrDependencies>;
  environment?: NodeJS.ProcessEnv;
}

type SessionContext = ExtensionContext & {
  sessionManager: ExtensionContext["sessionManager"] & {
    getSessionName?(): string | undefined;
  };
};

export default function register(
  pi: ExtensionAPI,
  config: SessionTitleConfig = loadConfig(),
  dependencies: RuntimeDependencies = {},
): void {
  let epoch = 0;
  let state: SessionTitleState | undefined;
  let inFlight: AbortController | undefined;
  let pendingOwnName: string | undefined;
  let namingWarningShown = false;
  let herdrWarningShown = false;
  let resolvedModel: string | undefined;

  const reporter: HerdrReporter = createHerdrReporter(
    dependencies.environment ? {
      HERDR_ENV: dependencies.environment.HERDR_ENV,
      HERDR_PANE_ID: dependencies.environment.HERDR_PANE_ID,
      HERDR_SOCKET_PATH: dependencies.environment.HERDR_SOCKET_PATH,
      HERDR_BIN_PATH: dependencies.environment.HERDR_BIN_PATH,
    } : undefined,
    {
      sendSocket: dependencies.herdr?.sendSocket ?? (async (path, request, timeoutMs) => {
        const { sendHerdrSocketAttempt } = await import("./herdr.js");
        return sendHerdrSocketAttempt(path, request, timeoutMs);
      }),
      exec: dependencies.herdr?.exec ?? (async (command, args) => {
        const result = await pi.exec(command, args, { timeout: 2_000 });
        return { code: result.code };
      }),
      now: dependencies.herdr?.now ?? Date.now,
    },
  );

  const branch = (ctx: SessionContext): readonly unknown[] => ctx.sessionManager.getBranch() as readonly unknown[];
  const turnCount = (ctx: SessionContext): number => extractCompletedExchanges(branch(ctx)).length;
  const sessionName = (ctx: SessionContext): string | undefined => (
    pi.getSessionName() ?? ctx.sessionManager.getSessionName?.()
  );

  const persistState = (next: SessionTitleState): void => {
    state = next;
    pi.appendEntry(STATE_ENTRY_TYPE, next);
  };

  const warnHerdrOnce = (ctx: SessionContext): void => {
    if (herdrWarningShown) return;
    herdrWarningShown = true;
    ctx.ui.notify("Session title was saved, but Herdr metadata synchronization failed.", "warning");
  };

  const syncDisplay = async (ctx: SessionContext, title = sessionName(ctx)): Promise<void> => {
    if (config.terminalTitle.enabled) {
      ctx.ui.setTitle(title ? renderTerminalTitle(config.terminalTitle.template, title, ctx.cwd) : "");
    }
    if (config.herdr.enabled && reporter.enabled) {
      const delivered = await reporter.report(title);
      if (!delivered) warnHerdrOnce(ctx);
    }
  };

  const markManual = (ctx: SessionContext, title = sessionName(ctx)): void => {
    const next = createState("manual", turnCount(ctx), title);
    persistState(next);
  };

  const contextStillCurrent = (
    ctx: SessionContext,
    captured: { epoch: number; file?: string; name?: string; turns: number },
  ): boolean => (
    epoch === captured.epoch
    && ctx.sessionManager.getSessionFile() === captured.file
    && sessionName(ctx) === captured.name
    && turnCount(ctx) === captured.turns
  );

  const showNamingWarning = (ctx: SessionContext, message: string): void => {
    if (namingWarningShown) return;
    namingWarningShown = true;
    ctx.ui.notify(message, "warning");
  };

  const evaluate = async (
    ctx: SessionContext,
    kind: NamingContext["kind"],
  ): Promise<void> => {
    if (inFlight) {
      if (kind === "manual") ctx.ui.notify("Session title generation is already in progress.", "info");
      return;
    }
    if (!config.enabled || ctx.mode !== "tui") return;

    const entries = branch(ctx);
    const turns = extractCompletedExchanges(entries).length;
    const currentName = sessionName(ctx);
    const namingContext = buildNamingContext(kind, entries, currentName);
    if (!namingContext) {
      if (kind === "manual") ctx.ui.notify("No conversation is available to generate a session title.", "warning");
      return;
    }
    if (kind === "manual") ctx.ui.notify("Generating session title...", "info");

    const captured = {
      epoch,
      file: ctx.sessionManager.getSessionFile(),
      name: currentName,
      turns,
    };
    const controller = new AbortController();
    inFlight = controller;

    try {
      const result = await requestTitle(
        namingContext,
        ctx,
        config,
        controller.signal,
        dependencies.title,
      );
      if (controller.signal.aborted || !contextStillCurrent(ctx, captured)) return;

      resolvedModel = result.model ?? resolvedModel;
      if (result.configuredModelFailed) {
        showNamingWarning(
          ctx,
          result.kind === "failed"
            ? "Configured session-title model is unavailable."
            : "Configured session-title model is unavailable; the current Pi model was used.",
        );
      }

      if (result.kind === "failed" || (result.kind === "keep" && !currentName)) {
        persistState(createState("failed", turns, currentName));
        showNamingWarning(ctx, "Automatic session title generation failed.");
        return;
      }

      if (result.kind === "keep") {
        persistState(createState("generated", turns, currentName));
        if (kind === "manual") ctx.ui.notify("Session title is already up to date.", "info");
        return;
      }

      if (!contextStillCurrent(ctx, captured)) return;
      pendingOwnName = result.title;
      pi.setSessionName(result.title);
      await syncDisplay(ctx, result.title);
      if (!contextStillCurrent(ctx, { ...captured, name: result.title })) return;
      persistState(createState("generated", turns, result.title));
      if (kind === "manual") ctx.ui.notify(`Session title updated: ${result.title}`, "info");
    } catch {
      if (!controller.signal.aborted && contextStillCurrent(ctx, captured)) {
        persistState(createState("failed", turns, currentName));
        showNamingWarning(ctx, "Automatic session title generation failed.");
      }
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  };

  const evaluateAutomatic = async (ctx: SessionContext): Promise<void> => {
    if (!config.enabled || ctx.mode !== "tui" || inFlight) return;
    const entries = branch(ctx);
    state = restoreState(entries);
    const currentName = sessionName(ctx);
    const turns = extractCompletedExchanges(entries).length;

    if (!state && currentName) {
      markManual(ctx, currentName);
      return;
    }
    if (state?.status !== "manual" && currentName !== state?.title && currentName !== undefined) {
      markManual(ctx, currentName);
      return;
    }
    if (state?.status !== "manual" && state?.title && currentName !== state.title) {
      markManual(ctx, currentName);
      return;
    }

    const kind = nextAutomaticEvaluation(state, turns, config.refreshTurns);
    if (kind) await evaluate(ctx, kind);
  };

  pi.on("session_start", async (_event, rawContext) => {
    const ctx = rawContext as SessionContext;
    epoch += 1;
    inFlight?.abort();
    inFlight = undefined;
    pendingOwnName = undefined;
    namingWarningShown = false;
    herdrWarningShown = false;
    resolvedModel = undefined;
    state = restoreState(branch(ctx));

    const currentName = sessionName(ctx);
    if (!state && currentName) {
      markManual(ctx, currentName);
    } else if (state?.status !== "manual" && currentName !== state?.title) {
      markManual(ctx, currentName);
    }
    await syncDisplay(ctx, currentName);
  });

  pi.on("session_info_changed", async (event, rawContext) => {
    const ctx = rawContext as SessionContext;
    const changedName = event.name;
    if (pendingOwnName === changedName) {
      pendingOwnName = undefined;
    } else if (state?.status !== "manual" && changedName !== state?.title) {
      inFlight?.abort();
      markManual(ctx, changedName);
    }
    await syncDisplay(ctx, changedName);
  });

  pi.on("session_tree", (_event, rawContext) => {
    const ctx = rawContext as SessionContext;
    epoch += 1;
    inFlight?.abort();
    inFlight = undefined;
    state = restoreState(branch(ctx));
    void syncDisplay(ctx);
  });

  pi.on("agent_start", (_event, rawContext) => {
    void syncDisplay(rawContext as SessionContext);
  });

  pi.on("agent_settled", (_event, rawContext) => {
    const ctx = rawContext as SessionContext;
    void syncDisplay(ctx);
    void evaluateAutomatic(ctx);
  });

  pi.on("session_shutdown", async (event, rawContext) => {
    epoch += 1;
    inFlight?.abort();
    inFlight = undefined;
    if (event.reason === "quit" && config.herdr.enabled && reporter.enabled) {
      const delivered = await reporter.report(undefined);
      if (!delivered) warnHerdrOnce(rawContext as SessionContext);
    }
  });

  pi.registerCommand("session-title", {
    description: "Regenerate or inspect the automatic session title",
    handler: async (args, rawContext) => {
      const ctx = rawContext as SessionContext & { waitForIdle(): Promise<void> };
      const command = args.trim();
      if (command === "status") {
        const current = sessionName(ctx) ?? "(unnamed)";
        const currentState = restoreState(branch(ctx));
        let finalModel = resolvedModel;
        if (!finalModel) {
          const configured = parseModelReference(config.model);
          const configuredModel = configured
            ? ctx.modelRegistry.find(configured.provider, configured.modelId)
            : undefined;
          if (configuredModel) {
            try {
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(configuredModel);
              if (auth.ok && auth.apiKey) finalModel = `${configuredModel.provider}/${configuredModel.id}`;
            } catch {
              // Status falls back to the current model when configured authentication is unavailable.
            }
          }
          finalModel ??= ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(unavailable)";
        }
        ctx.ui.notify(
          `enabled=${config.enabled}; state=${currentState?.status ?? "pending"}; name=${current}; configured=${configuredModelLabel(config)}; resolved=${finalModel}`,
          "info",
        );
        return;
      }
      if (command) {
        ctx.ui.notify("Usage: /session-title [status]", "warning");
        return;
      }
      if (!config.enabled) {
        ctx.ui.notify("pi-session-title is disabled.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/session-title requires interactive mode.", "warning");
        return;
      }

      await ctx.waitForIdle();
      state = restoreState(branch(ctx));
      if (state?.status === "manual") {
        const confirmed = await ctx.ui.confirm(
          "Replace manual session name?",
          "This gives title ownership back to pi-session-title.",
        );
        if (!confirmed) return;
      }

      const currentName = sessionName(ctx);
      persistState(createState("generated", turnCount(ctx), currentName));
      await evaluate(ctx, "manual");
    },
  });
}

export * from "./core.js";
export * from "./herdr.js";
