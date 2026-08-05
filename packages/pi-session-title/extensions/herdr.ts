import { createConnection } from "node:net";

export const HERDR_SOURCE = "user:pi-session-title";
export const HERDR_AGENT = "pi";
export const HERDR_INTEGRATION_SOURCE = "herdr:pi";

export interface HerdrEnvironment {
  HERDR_ENV?: string;
  HERDR_PANE_ID?: string;
  HERDR_SOCKET_PATH?: string;
  HERDR_BIN_PATH?: string;
}

export interface HerdrRequest {
  id: string;
  method: "pane.report_metadata";
  params: {
    pane_id: string;
    source: typeof HERDR_SOURCE;
    agent: typeof HERDR_AGENT;
    applies_to_source: typeof HERDR_INTEGRATION_SOURCE;
    seq: number;
    title?: string;
    clear_title?: true;
  };
}

export interface HerdrDependencies {
  sendSocket(path: string, request: HerdrRequest, timeoutMs: number): Promise<boolean>;
  exec(command: string, args: string[]): Promise<{ code: number }>;
  now(): number;
}

export interface HerdrReporter {
  enabled: boolean;
  report(title: string | undefined): Promise<boolean>;
  nextSequence(): number;
}

export function createHerdrRequest(paneId: string, title: string | undefined, seq: number): HerdrRequest {
  return {
    id: `${HERDR_SOURCE}:${seq}`,
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source: HERDR_SOURCE,
      agent: HERDR_AGENT,
      applies_to_source: HERDR_INTEGRATION_SOURCE,
      seq,
      ...(title ? { title } : { clear_title: true as const }),
    },
  };
}

export function createHerdrCliArgs(paneId: string, title: string | undefined, seq: number): string[] {
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    HERDR_SOURCE,
    "--agent",
    HERDR_AGENT,
    "--applies-to-source",
    HERDR_INTEGRATION_SOURCE,
    ...(title ? ["--title", title] : ["--clear-title"]),
    "--seq",
    String(seq),
  ];
}

export function sendHerdrSocketAttempt(path: string, request: HerdrRequest, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = createConnection(path);
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(success);
    };

    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (data) => {
      try {
        const response = JSON.parse(data.toString().split("\n", 1)[0] ?? "") as { error?: unknown };
        finish(!response.error);
      } catch {
        finish(false);
      }
    });
    socket.on("end", () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

const defaultDependencies: HerdrDependencies = {
  sendSocket: sendHerdrSocketAttempt,
  exec: async () => ({ code: 1 }),
  now: Date.now,
};

export function createHerdrReporter(
  environment: HerdrEnvironment = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
  },
  dependencies: HerdrDependencies = defaultDependencies,
): HerdrReporter {
  const paneId = environment.HERDR_PANE_ID?.trim();
  const socketPath = environment.HERDR_SOCKET_PATH?.trim();
  const enabled = environment.HERDR_ENV === "1" && Boolean(paneId) && Boolean(socketPath);
  let sequence = dependencies.now() * 1_000;

  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };

  return {
    enabled,
    nextSequence,
    async report(title) {
      if (!enabled || !paneId || !socketPath) return true;
      const seq = nextSequence();
      const request = createHerdrRequest(paneId, title, seq);
      if (await dependencies.sendSocket(socketPath, request, 500)) return true;
      if (await dependencies.sendSocket(socketPath, request, 1_500)) return true;

      const command = environment.HERDR_BIN_PATH?.trim() || "herdr";
      try {
        const result = await dependencies.exec(command, createHerdrCliArgs(paneId, title, seq));
        return result.code === 0;
      } catch {
        return false;
      }
    },
  };
}
