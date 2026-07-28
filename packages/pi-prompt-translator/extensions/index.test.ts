import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register, {
  DEFAULT_CACHE_MAX_AGE_DAYS,
  DEFAULT_CACHE_MAX_SIZE_BYTES,
  DEFAULT_SHORTCUT,
  createTranslationCache,
  createTranslationSession,
  normalizeConfig,
  parseModelReference,
  resolveTranslationModel,
  shouldTranslateEditorText,
  translateEditorDraft,
  type TranslationContext,
  type TranslationCache,
  type TranslationDependencies,
  type TranslationModelRegistry,
  type TranslatorConfig,
} from "./index.js";

type Model = NonNullable<TranslationContext["model"]>;
type CompletionResult = Awaited<ReturnType<TranslationDependencies["complete"]>>;

const currentModel = { provider: "test", id: "current" } as Model;
const configuredModel = { provider: "openrouter", id: "anthropic/claude-sonnet-4" } as Model;

function response(text: string, stopReason = "stop"): CompletionResult {
  return {
    content: [{ type: "text", text }],
    stopReason,
  } as CompletionResult;
}

function createRegistry(options: {
  configured?: Model;
  auth?: (model: Model) => Promise<{ ok: boolean; apiKey?: string }>;
} = {}): TranslationModelRegistry {
  return {
    find: (provider, modelId) =>
      provider === "openrouter" && modelId === "anthropic/claude-sonnet-4" ? options.configured : undefined,
    getApiKeyAndHeaders: options.auth ?? (async () => ({ ok: true, apiKey: "test-key" })),
  };
}

function createContext(draft: string, registry = createRegistry()): {
  context: TranslationContext;
  getEditorText: () => string;
  notifications: Array<{ message: string; level: string }>;
} {
  let editorText = draft;
  const notifications: Array<{ message: string; level: string }> = [];

  const context: TranslationContext = {
    model: currentModel,
    modelRegistry: registry,
    ui: {
      getEditorText: () => editorText,
      setEditorText: (text) => {
        editorText = text;
      },
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  return { context, getEditorText: () => editorText, notifications };
}

function createDependencies(
  complete: TranslationDependencies["complete"],
  cache = createMemoryCache(),
): TranslationDependencies {
  return {
    complete,
    createCache: () => cache,
  };
}

function createMemoryCache(): TranslationCache {
  const entries = new Map<string, string>();
  return {
    get: async (source) => entries.get(source),
    set: async (source, translation) => {
      entries.set(source, translation);
    },
  };
}

async function writeCacheEntryInSeparateProcess(path: string, source: string, translation: string): Promise<void> {
  const extensionUrl = new URL("./index.ts", import.meta.url).href;
  const script = `
    import { createTranslationCache } from ${JSON.stringify(extensionUrl)};
    const cache = createTranslationCache(
      { enabled: true, maxAgeDays: 90, maxSizeBytes: 1024 },
      ${JSON.stringify(path)},
    );
    await cache.set(${JSON.stringify(source)}, ${JSON.stringify(translation)});
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let errorOutput = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) throw new Error(`Cache writer exited with ${code}: ${errorOutput}`);
}

async function readDefaultStoragePaths(agentDir: string): Promise<{
  configPath: string;
  cachePath: string;
}> {
  const extensionUrl = new URL("./index.ts", import.meta.url).href;
  const script = `
    import { CACHE_PATH, CONFIG_PATH } from ${JSON.stringify(extensionUrl)};
    process.stdout.write(JSON.stringify({ configPath: CONFIG_PATH, cachePath: CACHE_PATH }));
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) throw new Error(`Storage path reader exited with ${code}: ${errorOutput}`);
  return JSON.parse(output) as {
    configPath: string;
    cachePath: string;
  };
}

function defaultConfig(): TranslatorConfig {
  return {
    shortcut: DEFAULT_SHORTCUT,
    cache: {
      enabled: true,
      maxAgeDays: DEFAULT_CACHE_MAX_AGE_DAYS,
      maxSizeBytes: DEFAULT_CACHE_MAX_SIZE_BYTES,
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 10; attempts++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error("Condition was not met.");
}

describe("configuration and model resolution", () => {
  test("derives default storage paths from the host agent directory", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-prompt-translator-agent-"));
    try {
      assert.deepEqual(await readDefaultStoragePaths(agentDir), {
        configPath: join(agentDir, "pi-prompt-translator.json"),
        cachePath: join(agentDir, "pi-prompt-translator.db"),
      });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  test("normalizes only object configuration values", () => {
    const defaultCache = {
      enabled: true,
      maxAgeDays: DEFAULT_CACHE_MAX_AGE_DAYS,
      maxSizeBytes: DEFAULT_CACHE_MAX_SIZE_BYTES,
    };
    assert.deepEqual(normalizeConfig(undefined), { shortcut: DEFAULT_SHORTCUT, cache: defaultCache });
    assert.deepEqual(normalizeConfig(["invalid"]), { shortcut: DEFAULT_SHORTCUT, cache: defaultCache });
    assert.deepEqual(
      normalizeConfig({
        model: " openai/gpt-5.4 ",
        shortcut: " CTRL+SHIFT+T ",
        cache: { enabled: false, maxAgeDays: 30, maxSizeBytes: 1024 },
        ignored: true,
      }),
      {
        model: "openai/gpt-5.4",
        shortcut: DEFAULT_SHORTCUT,
        cache: { enabled: false, maxAgeDays: 30, maxSizeBytes: 1024 },
      },
    );
  });

  test("splits model identifiers at the first slash", () => {
    assert.deepEqual(parseModelReference("openrouter/anthropic/claude-sonnet-4"), {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
    assert.equal(parseModelReference("openrouter"), undefined);
    assert.equal(parseModelReference("/model"), undefined);
  });

  test("falls back to the current model when configured model authentication fails", async () => {
    const resolved = await resolveTranslationModel(
      "openrouter/anthropic/claude-sonnet-4",
      currentModel,
      createRegistry({
        configured: configuredModel,
        auth: async (model) =>
          model === configuredModel ? { ok: false } : { ok: true, apiKey: "current-key" },
      }),
    );

    assert.equal(resolved.target?.model, currentModel);
    assert.equal(resolved.configuredModelFailed, true);
  });
});

describe("editor draft eligibility", () => {
  test("excludes empty, slash, and shell editor text", () => {
    assert.equal(shouldTranslateEditorText(""), false);
    assert.equal(shouldTranslateEditorText("  "), false);
    assert.equal(shouldTranslateEditorText("/model"), false);
    assert.equal(shouldTranslateEditorText("!git status"), false);
    assert.equal(shouldTranslateEditorText("!!git status"), false);
    assert.equal(shouldTranslateEditorText("Write tests for this module."), false);
    assert.equal(shouldTranslateEditorText("为这个模块编写测试。"), true);
  });
});

describe("on-demand editor translation", () => {
  test("normalizes a successful Chinese draft without submitting a message", async () => {
    const state = createContext(" \n为这个模块编写测试。\n ");
    let completionCalls = 0;
    let requestedText: string | undefined;
    let completeTranslation: ((result: CompletionResult) => void) | undefined;
    const context = Object.assign(state.context, {
      sendMessage: () => {
        throw new Error("Translation must not send a message.");
      },
      sendUserMessage: () => {
        throw new Error("Translation must not submit a user message.");
      },
    });
    const dependencies = createDependencies(async (_model, request) => {
      completionCalls++;
      const message = request.messages.at(-1) as UserMessage;
      requestedText = (message.content[0] as { type: "text"; text: string }).text;
      return new Promise<CompletionResult>((resolve) => {
        completeTranslation = resolve;
      });
    });

    const translation = translateEditorDraft(context, defaultConfig(), dependencies);
    await waitFor(() => completeTranslation !== undefined);

    assert.equal(requestedText, "为这个模块编写测试。");
    assert.equal(state.getEditorText(), "Translating prompt...");
    completeTranslation?.(response(" \nWrite tests for this module.\n "));
    await translation;
    assert.equal(state.getEditorText(), "Write tests for this module.");
    assert.equal(completionCalls, 1);
  });

  test("does not call a model or normalize non-Chinese text", async () => {
    const state = createContext(" \nWrite tests for this module.\n ");
    let completionCalls = 0;

    await translateEditorDraft(
      state.context,
      defaultConfig(),
      createDependencies(async () => {
        completionCalls++;
        return response("unexpected");
      }),
    );

    assert.equal(state.getEditorText(), " \nWrite tests for this module.\n ");
    assert.equal(completionCalls, 0);
  });

  test("does not overwrite an editor change during a cache miss", async () => {
    const state = createContext("为这个模块编写测试。");
    let resolveCache: ((translation: string | undefined) => void) | undefined;
    let completionCalls = 0;
    const cache: TranslationCache = {
      get: () =>
        new Promise<string | undefined>((resolve) => {
          resolveCache = resolve;
        }),
      set: async () => {},
    };

    const translation = translateEditorDraft(
      state.context,
      defaultConfig(),
      createDependencies(async () => {
        completionCalls++;
        return response("Write tests for this module.");
      }, cache),
    );

    await waitFor(() => resolveCache !== undefined);
    state.context.ui.setEditorText("Keep my edited prompt.");
    resolveCache?.(undefined);
    await translation;

    assert.equal(state.getEditorText(), "Keep my edited prompt.");
    assert.equal(completionCalls, 0);
  });

  test("keeps the original draft after failure or empty output", async () => {
    const originalDraft = " \n为这个模块编写测试。\n ";
    const failure = createContext(originalDraft);
    await translateEditorDraft(
      failure.context,
      defaultConfig(),
      createDependencies(async () => {
        throw new Error("network failure");
      }),
    );
    assert.equal(failure.getEditorText(), originalDraft);
    assert.equal(failure.notifications.at(-1)?.message, "Translation failed.");

    const empty = createContext(originalDraft);
    await translateEditorDraft(
      empty.context,
      defaultConfig(),
      createDependencies(async () => response("   ")),
    );
    assert.equal(empty.getEditorText(), originalDraft);
    assert.equal(empty.notifications.at(-1)?.message, "Translation returned no text.");
  });

  test("does not overwrite an editor change made while translating", async () => {
    const state = createContext("为这个模块编写测试。");
    let completeTranslation: ((result: CompletionResult) => void) | undefined;
    const success = translateEditorDraft(
      state.context,
      defaultConfig(),
      createDependencies(
        async () =>
          new Promise<CompletionResult>((resolve) => {
            completeTranslation = resolve;
          }),
      ),
    );

    await waitFor(() => completeTranslation !== undefined);
    state.context.ui.setEditorText("Write a different prompt.");
    completeTranslation?.(response("Write tests for this module."));
    await success;
    assert.equal(state.getEditorText(), "Write a different prompt.");

    const failed = createContext("为这个模块编写测试。");
    let failTranslation: ((reason: Error) => void) | undefined;
    const failure = translateEditorDraft(
      failed.context,
      defaultConfig(),
      createDependencies(
        async () =>
          new Promise<CompletionResult>((_resolve, reject) => {
            failTranslation = reject;
          }),
      ),
    );

    await waitFor(() => failTranslation !== undefined);
    failed.context.ui.setEditorText("Keep my edited prompt.");
    failTranslation?.(new Error("network failure"));
    await failure;
    assert.equal(failed.getEditorText(), "Keep my edited prompt.");
  });

  test("toggles normalized drafts without another model request", async () => {
    const state = createContext(" \n为这个模块编写测试。\n ");
    const session = createTranslationSession();
    let completionCalls = 0;
    const dependencies = createDependencies(async () => {
      completionCalls++;
      return response(" \nWrite tests for this module.\n ");
    });

    await translateEditorDraft(state.context, defaultConfig(), dependencies, session);
    assert.equal(state.getEditorText(), "Write tests for this module.");

    await translateEditorDraft(state.context, defaultConfig(), dependencies, session);
    assert.equal(state.getEditorText(), "为这个模块编写测试。");

    await translateEditorDraft(state.context, defaultConfig(), dependencies, session);
    assert.equal(state.getEditorText(), "Write tests for this module.");
    assert.equal(completionCalls, 1);
  });

  test("uses normalized drafts as cache keys in a new session", async () => {
    const cache = createMemoryCache();
    const source = " \n为这个模块编写测试。\n ";
    let completionCalls = 0;
    const first = createContext(source);
    await translateEditorDraft(
      first.context,
      defaultConfig(),
      createDependencies(async () => {
        completionCalls++;
        return response("Write tests for this module.");
      }, cache),
      createTranslationSession(),
    );

    const second = createContext("为这个模块编写测试。");
    await translateEditorDraft(
      second.context,
      defaultConfig(),
      createDependencies(async () => {
        throw new Error("Cache hits must not request a translation.");
      }, cache),
      createTranslationSession(),
    );

    assert.equal(second.getEditorText(), "Write tests for this module.");
    assert.equal(completionCalls, 1);
  });

  test("continues translating when the cache is unavailable", async () => {
    const state = createContext("为这个模块编写测试。");
    const unavailableCache: TranslationCache = {
      get: async () => {
        throw new Error("database is locked");
      },
      set: async () => {
        throw new Error("database is locked");
      },
    };

    await translateEditorDraft(
      state.context,
      defaultConfig(),
      createDependencies(async () => response("Write tests for this module."), unavailableCache),
      createTranslationSession(),
    );

    assert.equal(state.getEditorText(), "Write tests for this module.");
  });

  test("prevents concurrent shortcut presses from starting another translation", async () => {
    const state = createContext("为这个模块编写测试。");
    let completionCalls = 0;
    let completeTranslation: ((result: CompletionResult) => void) | undefined;
    const dependencies = createDependencies(
      async () =>
        new Promise<CompletionResult>((resolve) => {
          completionCalls++;
          completeTranslation = resolve;
        }),
    );
    const session = createTranslationSession();

    const first = translateEditorDraft(state.context, defaultConfig(), dependencies, session);
    const second = translateEditorDraft(state.context, defaultConfig(), dependencies, session);
    await waitFor(() => completionCalls === 1);
    assert.equal(completionCalls, 1);

    completeTranslation?.(response("Write tests for this module."));
    await Promise.all([first, second]);
    assert.equal(state.getEditorText(), "Write tests for this module.");
  });

  test("registers the shortcut and handles an OMP context without mode", async () => {
    let shortcutRegistrations = 0;
    let handler: ((context: TranslationContext) => Promise<void> | void) | undefined;
    const pi = {
      registerShortcut: (_shortcut: string, options: { handler: (context: TranslationContext) => Promise<void> | void }) => {
        shortcutRegistrations++;
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const state = createContext("为这个模块编写测试。");

    register(
      pi,
      defaultConfig(),
      createDependencies(async () => response("Write tests for this module.")),
    );
    await handler?.(state.context);

    assert.equal(shortcutRegistrations, 1);
    assert.equal(state.getEditorText(), "Write tests for this module.");
  });
});

describe("translation cache", () => {
  test("uses source keys directly and enforces the logical payload bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-prompt-translator-"));
    try {
      const cache = createTranslationCache(
        { enabled: true, maxAgeDays: 90, maxSizeBytes: 160 },
        join(directory, "cache.sqlite"),
      );
      await cache.set("__proto__", "Prototype source");
      assert.equal(await cache.get("__proto__"), "Prototype source");

      await cache.set("first", "A".repeat(128));
      await cache.set("second", "B".repeat(128));
      assert.equal(await cache.get("first"), undefined);
      assert.equal(await cache.get("second"), "B".repeat(128));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates private cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-prompt-translator-"));
    try {
      const cachePath = join(directory, "cache.sqlite");
      const cache = createTranslationCache({ enabled: true, maxAgeDays: 90, maxSizeBytes: 1024 }, cachePath);
      await cache.set("source", "Translation");

      if (process.platform !== "win32") {
        assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses transient rollback journals instead of WAL sidecars", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-prompt-translator-"));
    try {
      const cachePath = join(directory, "pi-prompt-translator.db");
      const cache = createTranslationCache({ enabled: true, maxAgeDays: 90, maxSizeBytes: 1024 }, cachePath);
      await cache.set("source", "Translation");

      for (const file of [`${cachePath}-wal`, `${cachePath}-shm`, `${cachePath}-journal`]) {
        await assert.rejects(stat(file), { code: "ENOENT" });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps both entries written by separate Pi processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-prompt-translator-"));
    try {
      const cachePath = join(directory, "cache.sqlite");
      await Promise.all([
        writeCacheEntryInSeparateProcess(cachePath, "first", "First"),
        writeCacheEntryInSeparateProcess(cachePath, "second", "Second"),
      ]);

      const cache = createTranslationCache({ enabled: true, maxAgeDays: 90, maxSizeBytes: 1024 }, cachePath);
      assert.equal(await cache.get("first"), "First");
      assert.equal(await cache.get("second"), "Second");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
