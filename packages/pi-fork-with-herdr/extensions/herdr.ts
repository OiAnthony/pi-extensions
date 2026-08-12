import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HerdrExecutor {
  exec(command: string, args: string[], options: { timeout: number }): Promise<ExecResult>;
}

export interface CreatedTab {
  tabId: string;
  paneId: string;
}

export interface HerdrClient {
  createTab(workspaceId: string, cwd: string): Promise<CreatedTab>;
  startAgent(name: string, paneId: string, sessionFile: string): Promise<void>;
  focusTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
}

interface HerdrEnvelope {
  result?: Record<string, unknown>;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly args: readonly string[] = [],
  ) {
    super(message);
    this.name = "HerdrCommandError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJson(text: string): HerdrEnvelope | undefined {
  if (!text.trim()) return undefined;
  try {
    return asRecord(JSON.parse(text)) as HerdrEnvelope | undefined;
  } catch {
    return undefined;
  }
}

function errorFrom(envelope: HerdrEnvelope | undefined, fallback: string, args: readonly string[]): HerdrCommandError {
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : undefined;
  const message = typeof envelope?.error?.message === "string" ? envelope.error.message : fallback;
  return new HerdrCommandError(message, code, args);
}

function requiredString(value: unknown, field: string, args: readonly string[]): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new HerdrCommandError(`Herdr response is missing ${field}.`, "invalid_response", args);
}

function requireResult(envelope: HerdrEnvelope, args: readonly string[]): Record<string, unknown> {
  if (envelope.error) throw errorFrom(envelope, "Herdr command failed.", args);
  const result = asRecord(envelope.result);
  if (!result) throw new HerdrCommandError("Herdr response is missing result.", "invalid_response", args);
  return result;
}

export function createHerdrClient(
  executor: HerdrExecutor,
  binary = "herdr",
  timeoutMs = 45_000,
): HerdrClient {
  const run = async (args: string[]): Promise<Record<string, unknown>> => {
    const execution = await executor.exec(binary, args, { timeout: timeoutMs });
    const output = execution.code === 0 ? execution.stdout : execution.stderr;
    const envelope = parseJson(output);
    if (execution.code !== 0) {
      throw errorFrom(envelope, output.trim() || `Herdr exited with code ${execution.code}.`, args);
    }
    if (!envelope) {
      throw new HerdrCommandError("Herdr returned invalid JSON.", "invalid_response", args);
    }
    return requireResult(envelope, args);
  };

  return {
    async createTab(workspaceId, cwd) {
      const args = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--no-focus"];
      const result = await run(args);
      const tab = asRecord(result.tab);
      const rootPane = asRecord(result.root_pane);
      return {
        tabId: requiredString(tab?.tab_id, "result.tab.tab_id", args),
        paneId: requiredString(rootPane?.pane_id, "result.root_pane.pane_id", args),
      };
    },

    async startAgent(name, paneId, sessionFile) {
      const args = [
        "agent", "start", name,
        "--kind", "pi",
        "--pane", paneId,
        "--", "--session", sessionFile,
      ];
      const result = await run(args);
      const agent = asRecord(result.agent);
      const returnedPaneId = requiredString(agent?.pane_id, "result.agent.pane_id", args);
      if (returnedPaneId !== paneId) {
        throw new HerdrCommandError(
          `Herdr started Pi in unexpected pane ${returnedPaneId}.`,
          "invalid_response",
          args,
        );
      }
    },

    async focusTab(tabId) {
      const args = ["tab", "focus", tabId];
      const result = await run(args);
      const tab = asRecord(result.tab);
      const returnedTabId = requiredString(tab?.tab_id, "result.tab.tab_id", args);
      if (returnedTabId !== tabId) {
        throw new HerdrCommandError(`Herdr focused unexpected tab ${returnedTabId}.`, "invalid_response", args);
      }
    },

    async closeTab(tabId) {
      const args = ["tab", "close", tabId];
      const result = await run(args);
      if (result.type !== "ok") {
        throw new HerdrCommandError("Herdr did not confirm tab closure.", "invalid_response", args);
      }
    },
  };
}

export function createPiHerdrClient(pi: ExtensionAPI, binary?: string): HerdrClient {
  return createHerdrClient({
    exec: async (command, args, options) => {
      const result = await pi.exec(command, args, options);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  }, binary);
}
