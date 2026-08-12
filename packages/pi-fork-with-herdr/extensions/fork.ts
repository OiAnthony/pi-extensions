import { randomUUID } from "node:crypto";
import type { HerdrClient } from "./herdr.js";
import { HerdrCommandError } from "./herdr.js";

export interface ForkRequest {
  workspaceId: string;
  cwd: string;
  sourceSessionFile: string;
  sessionDir: string;
  leafId: string;
}

export interface ForkDependencies {
  createSession(request: ForkRequest): Promise<string> | string;
  removeSession(path: string): Promise<void>;
  herdr: HerdrClient;
  generateAgentName(): string;
  maxNameAttempts?: number;
  maxShellAttempts?: number;
  waitForShell?(attempt: number): Promise<void>;
}

export type ForkOutcome =
  | {
    kind: "success";
    tabId: string;
    paneId: string;
    agentName: string;
    sessionFile: string;
  }
  | {
    kind: "warning" | "error";
    message: string;
    tabId?: string;
    paneId?: string;
    sessionFile?: string;
  };

export function generateAgentName(): string {
  return `pi-fork-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

export function isValidAgentName(name: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeUnusedSession(path: string, dependencies: ForkDependencies): Promise<string | undefined> {
  try {
    await dependencies.removeSession(path);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

async function waitForShell(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50 * attempt, 250)));
}

async function startAgentWithRetry(
  paneId: string,
  sessionFile: string,
  dependencies: ForkDependencies,
): Promise<string> {
  const nameAttempts = dependencies.maxNameAttempts ?? 3;
  const shellAttempts = dependencies.maxShellAttempts ?? 8;
  const wait = dependencies.waitForShell ?? waitForShell;
  let lastError: unknown;
  for (let nameAttempt = 0; nameAttempt < nameAttempts; nameAttempt++) {
    const name = dependencies.generateAgentName();
    if (!isValidAgentName(name)) throw new Error(`Generated invalid Herdr agent name: ${name}`);
    for (let shellAttempt = 1; shellAttempt <= shellAttempts; shellAttempt++) {
      try {
        await dependencies.herdr.startAgent(name, paneId, sessionFile);
        return name;
      } catch (error) {
        lastError = error;
        if (!(error instanceof HerdrCommandError)) throw error;
        if (error.errorCode === "agent_name_taken") break;
        if (error.errorCode !== "agent_pane_busy" || shellAttempt === shellAttempts) throw error;
        await wait(shellAttempt);
      }
    }
  }
  throw lastError ?? new Error("Unable to generate a unique Herdr agent name.");
}

export async function forkWithHerdr(
  request: ForkRequest,
  dependencies: ForkDependencies,
): Promise<ForkOutcome> {
  let sessionFile: string;
  try {
    sessionFile = await dependencies.createSession(request);
  } catch (error) {
    return { kind: "error", message: `Unable to fork the Pi session: ${errorMessage(error)}` };
  }

  let tab: { tabId: string; paneId: string };
  try {
    tab = await dependencies.herdr.createTab(request.workspaceId, request.cwd);
  } catch (error) {
    const cleanupError = await removeUnusedSession(sessionFile, dependencies);
    return {
      kind: "error",
      sessionFile: cleanupError ? sessionFile : undefined,
      message: cleanupError
        ? `Herdr tab creation failed: ${errorMessage(error)} Session cleanup failed for ${sessionFile}: ${cleanupError}`
        : `Herdr tab creation failed: ${errorMessage(error)}`,
    };
  }

  let agentName: string;
  try {
    agentName = await startAgentWithRetry(tab.paneId, sessionFile, dependencies);
  } catch (error) {
    try {
      await dependencies.herdr.closeTab(tab.tabId);
    } catch (cleanupError) {
      return {
        kind: "error",
        tabId: tab.tabId,
        paneId: tab.paneId,
        sessionFile,
        message: `Pi startup failed in pane ${tab.paneId}: ${errorMessage(error)} Could not confirm closure of tab ${tab.tabId}: ${errorMessage(cleanupError)} The derived session was retained at ${sessionFile}.`,
      };
    }

    const cleanupError = await removeUnusedSession(sessionFile, dependencies);
    return {
      kind: "error",
      tabId: tab.tabId,
      paneId: tab.paneId,
      sessionFile: cleanupError ? sessionFile : undefined,
      message: cleanupError
        ? `Pi startup failed in pane ${tab.paneId}: ${errorMessage(error)} Tab ${tab.tabId} was closed, but session cleanup failed for ${sessionFile}: ${cleanupError}`
        : `Pi startup failed in pane ${tab.paneId}: ${errorMessage(error)} Tab ${tab.tabId} was closed.`,
    };
  }

  try {
    await dependencies.herdr.focusTab(tab.tabId);
  } catch (error) {
    return {
      kind: "warning",
      tabId: tab.tabId,
      paneId: tab.paneId,
      sessionFile,
      message: `Pi is ready in Herdr tab ${tab.tabId} (pane ${tab.paneId}), but the tab could not be focused: ${errorMessage(error)}`,
    };
  }

  return {
    kind: "success",
    tabId: tab.tabId,
    paneId: tab.paneId,
    agentName,
    sessionFile,
  };
}
