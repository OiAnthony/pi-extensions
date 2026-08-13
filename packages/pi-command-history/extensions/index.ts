/**
 * Folder-based Command History
 *
 * Persists editor history per working directory so you can retrieve
 * previous commands across sessions. As long as you're in the same folder,
 * you can cycle through all commands ever entered there.
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, matchesKey, type EditorComponent } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi");
const HISTORY_DIR = join(PI_DIR, "folder-history");
const CONFIG_FILE = join(PI_DIR, "pi-command-history.json");
const DEBUG_FILE = join(PI_DIR, "pi-command-history-debug.log");
const MAX_HISTORY = 500;
const MAX_PERSISTED_HISTORY = MAX_HISTORY * 2;
const DEFAULT_PREV_KEY = "up";
const DEFAULT_NEXT_KEY = "down";
const SAFE_PREV_KEY = "ctrl+up";
const SAFE_NEXT_KEY = "ctrl+down";

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type ConflictStrategy = "auto" | "register" | "safe";
type HistoryContext = Parameters<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>[0];
type AutocompleteAwareEditor = EditorComponent & {
  getCursor?: () => { line: number; col: number };
  getLines?: () => string[];
  isShowingAutocomplete?: () => boolean;
  focused?: boolean;
};

type VisualBoundaryEditor = {
  isOnFirstVisualLine?: () => boolean;
  isOnLastVisualLine?: () => boolean;
};

type ShowStatus = "hidden" | "text" | "full";

interface Config {
  shortcuts?: {
    prev?: ShortcutKey;
    next?: ShortcutKey;
  };
  conflictStrategy?: ConflictStrategy;
  showStatus?: ShowStatus;
  debug?: boolean;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};

  const raw = readJsonFile(CONFIG_FILE);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const value = raw as Record<string, unknown>;
  const shortcuts =
    value.shortcuts && typeof value.shortcuts === "object" && !Array.isArray(value.shortcuts)
      ? (value.shortcuts as Record<string, unknown>)
      : undefined;

  const prev = readShortcut(shortcuts?.prev);
  const next = readShortcut(shortcuts?.next);
  const strategy = readConflictStrategy(value.conflictStrategy);

  return {
    ...(prev || next ? { shortcuts: { prev, next } } : {}),
    ...(strategy ? { conflictStrategy: strategy } : {}),
    showStatus: readShowStatus(value.showStatus) ?? "hidden",
    ...(typeof value.debug === "boolean" ? { debug: value.debug } : {}),
  };
}

function readShowStatus(value: unknown): ShowStatus | undefined {
  return value === "hidden" || value === "text" || value === "full" ? value : undefined;
}

function readShortcut(value: unknown): ShortcutKey | undefined {
  return typeof value === "string" && value.trim()
    ? (value.trim().toLowerCase() as ShortcutKey)
    : undefined;
}

function readConflictStrategy(value: unknown): ConflictStrategy | undefined {
  return value === "auto" || value === "register" || value === "safe" ? value : undefined;
}

function getHistoryFile(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex");
  return join(HISTORY_DIR, `${hash}.jsonl`);
}

function getLegacyHistoryFile(cwd: string): string {
  return join(HISTORY_DIR, `${cwd.replaceAll("/", "-")}.jsonl`);
}

interface LoadedHistory {
  entries: string[];
  recordCount: number;
}

async function loadHistory(cwd: string): Promise<LoadedHistory> {
  const file = getHistoryFile(cwd);
  const legacyFile = getLegacyHistoryFile(cwd);
  const sourceFile = existsSync(file) ? file : existsSync(legacyFile) ? legacyFile : undefined;
  if (!sourceFile) return { entries: [], recordCount: 0 };

  try {
    const unique = new Map<string, string>();
    let recordCount = 0;
    for (const line of (await readFile(sourceFile, "utf-8")).split("\n")) {
      const entry = line.trim() ? readJsonFileLine(line) : undefined;
      if (typeof entry?.text !== "string" || entry.cwd !== cwd) continue;

      recordCount++;
      unique.delete(entry.text);
      unique.set(entry.text, entry.text);
    }

    const entries = [...unique.values()].slice(-MAX_HISTORY);
    if (sourceFile === legacyFile) {
      try {
        await compactHistory(cwd, entries);
      } catch {
        // Keep using the legacy file when its one-time migration cannot be written.
      }
    }

    return { entries, recordCount: sourceFile === legacyFile ? entries.length : recordCount };
  } catch {
    return { entries: [], recordCount: 0 };
  }
}

function readJsonFileLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function appendHistory(cwd: string, text: string): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });
  await appendFile(
    getHistoryFile(cwd),
    JSON.stringify({ cwd, text, ts: Date.now() }) + "\n",
    "utf-8",
  );
}

async function compactHistory(cwd: string, entries: string[]): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });
  const file = getHistoryFile(cwd);
  const temporaryFile = `${file}.tmp`;
  const data = entries.map((text) => JSON.stringify({ cwd, text, ts: Date.now() })).join("\n");
  await writeFile(temporaryFile, data ? `${data}\n` : "", "utf-8");
  await rename(temporaryFile, file);
}

function formatShortcutHint(prev: string, next: string): string {
  const prevParts = prev.split("+");
  const nextParts = next.split("+");
  const sameModifier =
    prevParts.length > 1 &&
    nextParts.length > 1 &&
    prevParts.slice(0, -1).join("+") === nextParts.slice(0, -1).join("+");

  return sameModifier
    ? `(${prevParts.slice(0, -1).join("+")}+${prevParts.at(-1)}/${nextParts.at(-1)})`
    : `(${prev}/${next})`;
}

function isKnownConflict(shortcut: ShortcutKey): boolean {
  return shortcut === "up" || shortcut === "down";
}

export function matchesHistoryKeyEvent(data: string, shortcut: ShortcutKey): boolean {
  return !isKeyRelease(data) && matchesKey(data, shortcut);
}

export function getHistoryNavigationAction(
  editor: AutocompleteAwareEditor | undefined,
  editorText: string,
  historyIndex: number,
  historyLength: number,
  matchesPrev: boolean,
  matchesNext: boolean,
): "previous" | "next" | undefined {
  if (matchesPrev === matchesNext || historyLength === 0 || !editor || editor.focused === false) {
    return undefined;
  }
  if (editor?.isShowingAutocomplete?.()) return undefined;

  const visualEditor = editor as VisualBoundaryEditor | undefined;

  if (historyIndex === -1) {
    return matchesPrev && editorText.length === 0 ? "previous" : undefined;
  }

  if (matchesPrev) {
    const isOnFirstVisualLine = visualEditor?.isOnFirstVisualLine?.();
    return isOnFirstVisualLine ? "previous" : undefined;
  }

  if (matchesNext) {
    const isOnLastVisualLine = visualEditor?.isOnLastVisualLine?.();
    return isOnLastVisualLine ? "next" : undefined;
  }

  return undefined;
}

function formatRawInput(data: string): string {
  return [...data]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return "?";
      if (code >= 32 && code <= 126) return char;
      return String.raw`\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
}

export default function register(pi: ExtensionAPI) {
  const config = readConfig();
  const conflictStrategy = config.conflictStrategy ?? "auto";
  const configuredPrevKey = config.shortcuts?.prev ?? DEFAULT_PREV_KEY;
  const configuredNextKey = config.shortcuts?.next ?? DEFAULT_NEXT_KEY;
  const keyPrev =
    conflictStrategy === "safe" && isKnownConflict(configuredPrevKey)
      ? SAFE_PREV_KEY
      : configuredPrevKey;
  const keyNext =
    conflictStrategy === "safe" && isKnownConflict(configuredNextKey)
      ? SAFE_NEXT_KEY
      : configuredNextKey;
  const shortcutsAreDistinct = keyPrev !== keyNext;
  const showStatus = config.showStatus ?? "hidden";
  const debugEnabled = config.debug === true || process.env.PI_COMMAND_HISTORY_DEBUG === "1";
  const shouldUseRawInput = (shortcut: ShortcutKey) =>
    conflictStrategy === "auto" && isKnownConflict(shortcut);

  let history: string[] = [];
  let historyIndex = -1;
  let currentCwd = "";
  let currentStatusLabel: string | undefined;
  let currentEditor: AutocompleteAwareEditor | undefined;
  let unsubscribeRawInput: (() => void) | undefined;
  let persistedRecordCount = 0;
  let compactionScheduled = false;
  let persistenceQueue = Promise.resolve();
  let debugQueue = Promise.resolve();

  const debug = (message: string, data?: Record<string, unknown>): void => {
    if (!debugEnabled) return;

    const dataPart = data ? ` ${JSON.stringify(data)}` : "";
    debugQueue = debugQueue
      .then(async () => {
        await mkdir(PI_DIR, { recursive: true });
        await appendFile(DEBUG_FILE, `[${new Date().toISOString()}] ${message}${dataPart}\n`, "utf-8");
      })
      .catch(() => {});
  };

  const enqueuePersistence = (operation: () => Promise<void>, onFailure?: () => void): void => {
    persistenceQueue = persistenceQueue.then(operation).catch((error: unknown) => {
      onFailure?.();
      debug("history persistence failed", { error: String(error) });
    });
  };

  const refreshStatus = (ctx: HistoryContext): void => {
    ctx.ui.setStatus("folder-history", currentStatusLabel);
  };

  const showPrevious = (ctx: HistoryContext): boolean => {
    const nextIndex = historyIndex + 1;
    if (nextIndex >= history.length) {
      debug("showPrevious skipped", {
        reason: history.length ? "oldest-entry" : "empty-history",
        historyIndex,
        historyLength: history.length,
      });
      return false;
    }

    historyIndex = nextIndex;
    ctx.ui.setEditorText(history[history.length - 1 - historyIndex]);
    refreshStatus(ctx);
    debug("showPrevious applied", { historyIndex, historyLength: history.length });
    return true;
  };

  const showNext = (ctx: HistoryContext): boolean => {
    if (historyIndex <= -1) {
      debug("showNext skipped", { reason: "not-browsing", historyIndex });
      return false;
    }

    historyIndex--;
    ctx.ui.setEditorText(historyIndex === -1 ? "" : history[history.length - 1 - historyIndex]);
    refreshStatus(ctx);
    debug("showNext applied", { historyIndex, historyLength: history.length });
    return true;
  };

  const registerHistoryShortcut = (
    shortcut: ShortcutKey,
    description: string,
    direction: "previous" | "next",
  ): void => {
    if (!shortcutsAreDistinct || shouldUseRawInput(shortcut)) {
      debug("registerShortcut skipped for raw input", { shortcut, description });
      return;
    }

    debug("registerShortcut registered", { shortcut, description });
    pi.registerShortcut(shortcut, {
      description,
      handler: (ctx) => {
        const action = getHistoryNavigationAction(
          currentEditor,
          ctx.ui.getEditorText(),
          historyIndex,
          history.length,
          direction === "previous",
          direction === "next",
        );
        if (action === "previous") showPrevious(ctx);
        if (action === "next") showNext(ctx);
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    const loadedHistory = await loadHistory(currentCwd);
    history = loadedHistory.entries;
    persistedRecordCount = loadedHistory.recordCount;
    historyIndex = -1;
    compactionScheduled = false;

    let icon = "";
    if (showStatus === "full") icon = "📜 ";
    currentStatusLabel =
      history.length > 0 && showStatus !== "hidden"
        ? `${icon}${history.length} cmds ${formatShortcutHint(keyPrev, keyNext)}`
        : undefined;

    debug("session_start", {
      cwd: currentCwd,
      historyLength: history.length,
      configuredPrevKey,
      configuredNextKey,
      conflictStrategy,
      keyPrev,
      keyNext,
      showStatus,
    });

    if (showStatus !== "hidden") {
      ctx.ui.setStatus("folder-history", currentStatusLabel);
    }

    if (!shortcutsAreDistinct) {
      console.warn("[pi-command-history] Previous and next history shortcuts must differ; shortcuts disabled.");
      return;
    }

    const previousEditorFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor =
        previousEditorFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings);
      currentEditor = editor;
      return editor;
    });

    unsubscribeRawInput?.();
    const useRawPrev = shouldUseRawInput(keyPrev);
    const useRawNext = shouldUseRawInput(keyNext);
    if (!useRawPrev && !useRawNext) {
      debug("raw input listener not registered", { keyPrev, keyNext, useRawPrev, useRawNext });
      unsubscribeRawInput = undefined;
      return;
    }

    debug("raw input listener registered", { keyPrev, keyNext, useRawPrev, useRawNext });
    unsubscribeRawInput = ctx.ui.onTerminalInput((data) => {
      const matchesPrev = useRawPrev && matchesHistoryKeyEvent(data, keyPrev);
      const matchesNext = useRawNext && matchesHistoryKeyEvent(data, keyNext);
      if (!matchesPrev && !matchesNext) {
        return;
      }

      const editorText = ctx.ui.getEditorText();
      if (debugEnabled) {
        debug("raw input received", {
          raw: formatRawInput(data),
          length: data.length,
          editorLength: editorText.length,
          singleLine: !editorText.includes("\n"),
          cursorLine: currentEditor?.getCursor?.().line,
          lineCount: currentEditor?.getLines?.().length,
          matchesPrev,
          matchesNext,
          historyIndex,
          historyLength: history.length,
        });
      }

      const action = getHistoryNavigationAction(
        currentEditor,
        editorText,
        historyIndex,
        history.length,
        matchesPrev,
        matchesNext,
      );
      if (!action) {
        debug("raw input passed through", { reason: "not-history-boundary" });
        return;
      }

      if (action === "previous") showPrevious(ctx);
      if (action === "next") showNext(ctx);
      debug("raw input consumed", { action });
      return { consume: true };
    });
  });

  pi.on("session_shutdown", async () => {
    debug("session_shutdown");
    unsubscribeRawInput?.();
    unsubscribeRawInput = undefined;
    await persistenceQueue;
    await debugQueue;
  });

  pi.on("input", (event, ctx) => {
    const text = event.text?.trim();
    if (!text || !currentCwd) {
      debug("input skipped", { hasText: Boolean(text), hasCurrentCwd: Boolean(currentCwd) });
      return;
    }

    debug("input saved", { length: text.length, cwd: currentCwd });
    history = [...history.filter((entry) => entry !== text), text].slice(-MAX_HISTORY);
    historyIndex = -1;
    persistedRecordCount++;
    const shouldCompact = persistedRecordCount >= MAX_PERSISTED_HISTORY && !compactionScheduled;
    const historySnapshot = shouldCompact ? [...history] : undefined;
    const recordCountAtCompaction = persistedRecordCount;
    compactionScheduled ||= shouldCompact;
    const cwd = currentCwd;

    enqueuePersistence(async () => {
      await appendHistory(cwd, text);
      if (!historySnapshot) return;

      await compactHistory(cwd, historySnapshot);
      persistedRecordCount = historySnapshot.length + persistedRecordCount - recordCountAtCompaction;
      compactionScheduled = false;
    }, historySnapshot ? () => { compactionScheduled = false; } : undefined);
    const icon = showStatus === "full" ? "📜 " : "";
    currentStatusLabel =
      showStatus !== "hidden"
        ? `${icon}${history.length} cmds ${formatShortcutHint(keyPrev, keyNext)}`
        : undefined;
    refreshStatus(ctx);

    return { action: "continue" as const };
  });

  registerHistoryShortcut(keyPrev, "Previous command from folder history", "previous");
  registerHistoryShortcut(keyNext, "Next command from folder history", "next");
}
