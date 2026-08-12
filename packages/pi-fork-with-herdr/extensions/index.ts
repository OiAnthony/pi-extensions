import { access, unlink } from "node:fs/promises";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forkWithHerdr, generateAgentName, type ForkDependencies, type ForkRequest } from "./fork.js";
import { createPiHerdrClient } from "./herdr.js";

export interface RuntimeDependencies {
  environment?: NodeJS.ProcessEnv;
  fileExists?(path: string): Promise<boolean>;
  removeSession?(path: string): Promise<void>;
  createSession?(request: ForkRequest): Promise<string> | string;
  fork?: Partial<Omit<ForkDependencies, "createSession" | "removeSession">>;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultCreateSession(request: ForkRequest): string {
  const manager = SessionManager.open(request.sourceSessionFile, request.sessionDir);
  const sessionFile = manager.createBranchedSession(request.leafId);
  if (!sessionFile) throw new Error("Pi did not create a persistent derived session.");
  return sessionFile;
}

export default function register(pi: ExtensionAPI, runtime: RuntimeDependencies = {}): void {
  const environment = runtime.environment ?? process.env;
  const fileExists = runtime.fileExists ?? defaultFileExists;
  const removeSession = runtime.removeSession ?? unlink;

  pi.registerCommand("fork-with-herdr", {
    description: "Fork the active session branch into a new Herdr tab",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/fork-with-herdr requires Pi TUI mode.", "error");
        return;
      }
      if (environment.HERDR_ENV !== "1") {
        ctx.ui.notify("/fork-with-herdr requires a Herdr-managed Pi pane.", "error");
        return;
      }

      const workspaceId = environment.HERDR_WORKSPACE_ID;
      const sourcePaneId = environment.HERDR_PANE_ID;
      if (!workspaceId || !sourcePaneId) {
        ctx.ui.notify("Herdr workspace or pane context is missing.", "error");
        return;
      }

      await ctx.waitForIdle();

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !await fileExists(sessionFile)) {
        ctx.ui.notify("The current Pi session has not been persisted yet.", "error");
        return;
      }

      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify("The current Pi session is empty and cannot be forked.", "error");
        return;
      }

      const request: ForkRequest = {
        workspaceId,
        cwd: ctx.cwd,
        sourceSessionFile: sessionFile,
        sessionDir: ctx.sessionManager.getSessionDir(),
        leafId,
      };
      const outcome = await forkWithHerdr(request, {
        createSession: runtime.createSession ?? defaultCreateSession,
        removeSession,
        herdr: runtime.fork?.herdr ?? createPiHerdrClient(pi, environment.HERDR_BIN_PATH),
        generateAgentName: runtime.fork?.generateAgentName ?? generateAgentName,
        maxNameAttempts: runtime.fork?.maxNameAttempts,
        maxShellAttempts: runtime.fork?.maxShellAttempts,
        waitForShell: runtime.fork?.waitForShell,
      });

      if (outcome.kind === "success") {
        ctx.ui.notify(
          `Forked the active branch into Herdr tab ${outcome.tabId} (pane ${outcome.paneId}). The Pi session is isolated; the cwd is shared.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(outcome.message, outcome.kind);
    },
  });
}

export * from "./fork.js";
export * from "./herdr.js";
