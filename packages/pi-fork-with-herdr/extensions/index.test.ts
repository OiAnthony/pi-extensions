import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register, {
  HerdrCommandError,
  createHerdrClient,
  forkWithHerdr,
  generateAgentName,
  isValidAgentName,
  type ForkDependencies,
  type ForkRequest,
  type HerdrClient,
} from "./index.js";

const request: ForkRequest = {
  workspaceId: "w1",
  cwd: "/tmp/project",
  sourceSessionFile: "/tmp/source.jsonl",
  sessionDir: "/tmp/sessions",
  leafId: "live-leaf",
};

function fakeHerdr(overrides: Partial<HerdrClient> = {}): HerdrClient {
  return {
    createTab: async () => ({ tabId: "w1:t2", paneId: "w1:p2" }),
    startAgent: async () => {},
    focusTab: async () => {},
    closeTab: async () => {},
    ...overrides,
  };
}

function forkDependencies(overrides: Partial<ForkDependencies> = {}): ForkDependencies {
  return {
    createSession: () => "/tmp/derived.jsonl",
    removeSession: async () => {},
    herdr: fakeHerdr(),
    generateAgentName: () => "pi-fork-1234abcd",
    ...overrides,
  };
}

function message(role: "user" | "assistant", content: string): any {
  if (role === "user") return { role, content, timestamp: Date.now() };
  return {
    role,
    content: [{ type: "text", text: content }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("Herdr CLI boundary", () => {
  test("uses argument arrays and validates create, start, focus, and close responses", async () => {
    const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
    const outputs = [
      { result: { type: "tab_created", tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } },
      { result: { type: "agent_started", agent: { pane_id: "w1:p2" }, argv: ["pi"] } },
      { result: { type: "tab_info", tab: { tab_id: "w1:t2" } } },
      { result: { type: "ok" } },
    ];
    const client = createHerdrClient({
      exec: async (command, args, options) => {
        calls.push({ command, args, timeout: options.timeout });
        return { code: 0, stdout: JSON.stringify(outputs.shift()), stderr: "" };
      },
    }, "/opt/herdr", 12_000);

    assert.deepEqual(await client.createTab("w1", "/tmp/project"), { tabId: "w1:t2", paneId: "w1:p2" });
    await client.startAgent("pi-fork-abcd1234", "w1:p2", "/tmp/derived.jsonl");
    await client.focusTab("w1:t2");
    await client.closeTab("w1:t2");

    assert.deepEqual(calls, [
      {
        command: "/opt/herdr",
        args: ["tab", "create", "--workspace", "w1", "--cwd", "/tmp/project", "--no-focus"],
        timeout: 12_000,
      },
      {
        command: "/opt/herdr",
        args: [
          "agent", "start", "pi-fork-abcd1234", "--kind", "pi", "--pane", "w1:p2",
          "--", "--session", "/tmp/derived.jsonl",
        ],
        timeout: 12_000,
      },
      { command: "/opt/herdr", args: ["tab", "focus", "w1:t2"], timeout: 12_000 },
      { command: "/opt/herdr", args: ["tab", "close", "w1:t2"], timeout: 12_000 },
    ]);
  });

  test("rejects missing JSON fields and preserves structured Herdr error codes", async () => {
    const missing = createHerdrClient({
      exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { tab: {} } }), stderr: "" }),
    });
    await assert.rejects(() => missing.createTab("w1", "/tmp"), /result\.tab\.tab_id/);

    const conflict = createHerdrClient({
      exec: async () => ({
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ error: { code: "agent_name_taken", message: "already used" } }),
      }),
    });
    await assert.rejects(
      () => conflict.startAgent("pi-fork-abcd1234", "w1:p2", "/tmp/derived.jsonl"),
      (error: unknown) => error instanceof HerdrCommandError
        && error.errorCode === "agent_name_taken"
        && error.message === "already used",
    );
  });
});

describe("fork orchestration", () => {
  test("creates a same-cwd tab, starts the derived session, then focuses it", async () => {
    const calls: string[] = [];
    let capturedRequest: ForkRequest | undefined;
    const outcome = await forkWithHerdr(request, forkDependencies({
      createSession: (received) => {
        capturedRequest = received;
        calls.push("session");
        return "/tmp/derived.jsonl";
      },
      herdr: fakeHerdr({
        createTab: async (workspaceId, cwd) => {
          calls.push(`tab:${workspaceId}:${cwd}`);
          return { tabId: "w1:t2", paneId: "w1:p2" };
        },
        startAgent: async (name, paneId, sessionFile) => {
          calls.push(`agent:${name}:${paneId}:${sessionFile}`);
        },
        focusTab: async (tabId) => { calls.push(`focus:${tabId}`); },
      }),
    }));

    assert.deepEqual(capturedRequest, request);
    assert.deepEqual(calls, [
      "session",
      "tab:w1:/tmp/project",
      "agent:pi-fork-1234abcd:w1:p2:/tmp/derived.jsonl",
      "focus:w1:t2",
    ]);
    assert.deepEqual(outcome, {
      kind: "success",
      tabId: "w1:t2",
      paneId: "w1:p2",
      agentName: "pi-fork-1234abcd",
      sessionFile: "/tmp/derived.jsonl",
    });
  });

  test("retries a bounded agent-name conflict with a valid new name", async () => {
    const names = ["pi-fork-conflict", "pi-fork-unique"];
    const started: string[] = [];
    const outcome = await forkWithHerdr(request, forkDependencies({
      generateAgentName: () => names.shift()!,
      maxNameAttempts: 2,
      herdr: fakeHerdr({
        startAgent: async (name) => {
          started.push(name);
          if (name === "pi-fork-conflict") throw new HerdrCommandError("used", "agent_name_taken");
        },
      }),
    }));

    assert.deepEqual(started, ["pi-fork-conflict", "pi-fork-unique"]);
    assert.equal(outcome.kind, "success");
    assert.equal(outcome.kind === "success" ? outcome.agentName : undefined, "pi-fork-unique");
    assert.equal(isValidAgentName(generateAgentName()), true);
  });

  test("retries a transient busy root pane with the same agent name", async () => {
    const started: string[] = [];
    const waits: number[] = [];
    const outcome = await forkWithHerdr(request, forkDependencies({
      maxShellAttempts: 3,
      waitForShell: async (attempt) => { waits.push(attempt); },
      herdr: fakeHerdr({
        startAgent: async (name) => {
          started.push(name);
          if (started.length < 3) throw new HerdrCommandError("shell is not ready", "agent_pane_busy");
        },
      }),
    }));

    assert.equal(outcome.kind, "success");
    assert.deepEqual(started, ["pi-fork-1234abcd", "pi-fork-1234abcd", "pi-fork-1234abcd"]);
    assert.deepEqual(waits, [1, 2]);
  });

  test("deletes the derived session when tab creation fails", async () => {
    const removed: string[] = [];
    const outcome = await forkWithHerdr(request, forkDependencies({
      removeSession: async (path) => { removed.push(path); },
      herdr: fakeHerdr({ createTab: async () => { throw new Error("tab unavailable"); } }),
    }));

    assert.deepEqual(removed, ["/tmp/derived.jsonl"]);
    assert.equal(outcome.kind, "error");
    assert.match(outcome.kind === "error" ? outcome.message : "", /tab unavailable/);
  });

  test("reports both tab and session cleanup failures", async () => {
    const outcome = await forkWithHerdr(request, forkDependencies({
      removeSession: async () => { throw new Error("permission denied"); },
      herdr: fakeHerdr({ createTab: async () => { throw new Error("tab unavailable"); } }),
    }));

    assert.equal(outcome.kind, "error");
    assert.match(outcome.kind === "error" ? outcome.message : "", /permission denied/);
    assert.equal(outcome.sessionFile, "/tmp/derived.jsonl");
  });

  test("closes the tab before deleting the session after startup failure", async () => {
    const calls: string[] = [];
    const outcome = await forkWithHerdr(request, forkDependencies({
      removeSession: async () => { calls.push("remove"); },
      herdr: fakeHerdr({
        startAgent: async () => { throw new Error("Pi did not become ready"); },
        closeTab: async (tabId) => { calls.push(`close:${tabId}`); },
      }),
    }));

    assert.deepEqual(calls, ["close:w1:t2", "remove"]);
    assert.equal(outcome.kind, "error");
    assert.match(outcome.kind === "error" ? outcome.message : "", /pane w1:p2/);
  });

  test("retains the session when tab closure cannot be confirmed", async () => {
    let removed = false;
    const outcome = await forkWithHerdr(request, forkDependencies({
      removeSession: async () => { removed = true; },
      herdr: fakeHerdr({
        startAgent: async () => { throw new Error("startup timeout"); },
        closeTab: async () => { throw new Error("server unavailable"); },
      }),
    }));

    assert.equal(removed, false);
    assert.equal(outcome.sessionFile, "/tmp/derived.jsonl");
    assert.match(outcome.kind === "error" ? outcome.message : "", /tab w1:t2/);
    assert.match(outcome.kind === "error" ? outcome.message : "", /pane w1:p2/);
  });

  test("reports failed session deletion after confirmed tab closure", async () => {
    const outcome = await forkWithHerdr(request, forkDependencies({
      removeSession: async () => { throw new Error("unlink denied"); },
      herdr: fakeHerdr({ startAgent: async () => { throw new Error("startup failed"); } }),
    }));

    assert.equal(outcome.sessionFile, "/tmp/derived.jsonl");
    assert.match(outcome.kind === "error" ? outcome.message : "", /Tab w1:t2 was closed/);
    assert.match(outcome.kind === "error" ? outcome.message : "", /unlink denied/);
  });

  test("retains running resources and warns when focus fails", async () => {
    let removed = false;
    let closed = false;
    const outcome = await forkWithHerdr(request, forkDependencies({
      removeSession: async () => { removed = true; },
      herdr: fakeHerdr({
        focusTab: async () => { throw new Error("focus denied"); },
        closeTab: async () => { closed = true; },
      }),
    }));

    assert.equal(outcome.kind, "warning");
    assert.equal(removed, false);
    assert.equal(closed, false);
    assert.match(outcome.kind === "warning" ? outcome.message : "", /tab w1:t2/);
  });

  test("does not create Herdr resources when session creation fails", async () => {
    let externalCalls = 0;
    const outcome = await forkWithHerdr(request, forkDependencies({
      createSession: () => { throw new Error("leaf missing"); },
      herdr: fakeHerdr({ createTab: async () => {
        externalCalls++;
        return { tabId: "w1:t2", paneId: "w1:p2" };
      } }),
    }));

    assert.equal(outcome.kind, "error");
    assert.equal(externalCalls, 0);
  });
});

describe("extension command", () => {
  function createHarness(options: {
    mode?: string;
    environment?: NodeJS.ProcessEnv;
    sessionFile?: string;
    fileExists?: boolean;
    leafId?: string | null;
    waitForIdle?: () => Promise<void>;
    createSession?: (request: ForkRequest) => string;
  } = {}) {
    let command: ((args: string, ctx: any) => Promise<void>) | undefined;
    const notifications: Array<{ message: string; level: string }> = [];
    let createCalls = 0;
    let leafId = options.leafId === undefined ? "live-leaf" : options.leafId;
    const context = {
      mode: options.mode ?? "tui",
      cwd: "/tmp/project",
      waitForIdle: options.waitForIdle ?? (async () => {}),
      sessionManager: {
        getSessionFile: () => options.sessionFile === undefined ? "/tmp/source.jsonl" : options.sessionFile,
        getSessionDir: () => "/tmp/sessions",
        getLeafId: () => leafId,
      },
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    };
    const pi = {
      registerCommand: (_name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
        command = definition.handler;
      },
      exec: async () => { throw new Error("unexpected CLI call"); },
    } as unknown as ExtensionAPI;
    register(pi, {
      environment: options.environment ?? {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "w1:p1",
      },
      fileExists: async () => options.fileExists ?? true,
      createSession: (received) => {
        createCalls++;
        return options.createSession?.(received) ?? "/tmp/derived.jsonl";
      },
      removeSession: async () => {},
      fork: {
        herdr: fakeHerdr(),
        generateAgentName: () => "pi-fork-1234abcd",
      },
    });
    return {
      context,
      notifications,
      run: async () => command?.("", context),
      createCalls: () => createCalls,
      setLeafId: (value: string | null) => { leafId = value; },
    };
  }

  test("rejects non-TUI and non-Herdr contexts without side effects", async () => {
    const nonTui = createHarness({ mode: "rpc" });
    await nonTui.run();
    assert.equal(nonTui.createCalls(), 0);
    assert.match(nonTui.notifications[0]?.message ?? "", /TUI mode/);

    const nonHerdr = createHarness({ environment: {} });
    await nonHerdr.run();
    assert.equal(nonHerdr.createCalls(), 0);
    assert.match(nonHerdr.notifications[0]?.message ?? "", /Herdr-managed/);

    const missingPane = createHarness({ environment: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" } });
    await missingPane.run();
    assert.equal(missingPane.createCalls(), 0);
    assert.match(missingPane.notifications[0]?.message ?? "", /context is missing/);
  });

  test("rejects empty and unpersisted sessions without creating a tab", async () => {
    const empty = createHarness({ leafId: null });
    await empty.run();
    assert.equal(empty.createCalls(), 0);
    assert.match(empty.notifications[0]?.message ?? "", /empty/);

    const noFile = createHarness({ fileExists: false });
    await noFile.run();
    assert.equal(noFile.createCalls(), 0);
    assert.match(noFile.notifications[0]?.message ?? "", /not been persisted/);

    const noPath = createHarness({ sessionFile: "" });
    await noPath.run();
    assert.equal(noPath.createCalls(), 0);
    assert.match(noPath.notifications[0]?.message ?? "", /not been persisted/);
  });

  test("waits for idle before capturing the live active leaf", async () => {
    let harness: ReturnType<typeof createHarness>;
    let captured: ForkRequest | undefined;
    harness = createHarness({
      leafId: "stale-file-leaf",
      waitForIdle: async () => { harness.setLeafId("live-tree-leaf"); },
      createSession: (received) => {
        captured = received;
        return "/tmp/derived.jsonl";
      },
    });

    await harness.run();
    assert.equal(captured?.leafId, "live-tree-leaf");
    assert.equal(captured?.sourceSessionFile, "/tmp/source.jsonl");
    assert.equal(captured?.sessionDir, "/tmp/sessions");
  });

  test("uses an independent SessionManager to persist only the live branch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fork-with-herdr-"));
    try {
      const source = SessionManager.create("/tmp/project", directory);
      source.appendMessage(message("user", "root"));
      const firstAssistant = source.appendMessage(message("assistant", "first"));
      source.appendMessage(message("user", "live branch"));
      const liveLeaf = source.appendMessage(message("assistant", "live leaf"));
      source.branch(firstAssistant);
      source.appendMessage(message("user", "physical branch"));
      source.appendMessage(message("assistant", "physical leaf"));
      source.branch(liveLeaf);

      const sourceFile = source.getSessionFile();
      assert.ok(sourceFile);
      let derivedFile: string | undefined;
      let command: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerCommand: (_name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
          command = definition.handler;
        },
        exec: async () => { throw new Error("unexpected CLI call"); },
      } as unknown as ExtensionAPI;
      register(pi, {
        environment: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
        fork: {
          herdr: fakeHerdr({
            startAgent: async (_name, _pane, sessionFile) => { derivedFile = sessionFile; },
          }),
          generateAgentName: () => "pi-fork-1234abcd",
        },
      });
      await command?.("", {
        mode: "tui",
        cwd: "/tmp/project",
        waitForIdle: async () => {},
        sessionManager: source,
        ui: { notify: () => {} },
      });

      assert.ok(derivedFile);
      assert.notEqual(derivedFile, sourceFile);
      assert.equal(source.getSessionFile(), sourceFile);
      assert.equal(source.getLeafId(), liveLeaf);

      const header = JSON.parse((await readFile(derivedFile, "utf8")).split("\n")[0]!);
      assert.equal(header.parentSession, sourceFile);
      const derived = SessionManager.open(derivedFile, directory);
      assert.deepEqual(
        derived.getBranch().filter((entry) => entry.type === "message").map((entry: any) =>
          typeof entry.message.content === "string"
            ? entry.message.content
            : entry.message.content[0]?.text),
        ["root", "first", "live branch", "live leaf"],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
