import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isResolvedModelTarget,
  loadModelRoles,
  resolveModelTarget,
  type ModelAuth,
  type ModelRegistryLike,
  type ModelRolesConfig,
  type ThinkingLevel,
} from "@oipsanthony/pi-model-roles";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_SHORTCUT = "ctrl+shift+t";
const AGENT_DIR = getAgentDir();
export const CONFIG_PATH = join(AGENT_DIR, "pi-prompt-translator.json");
export const CACHE_PATH = join(AGENT_DIR, "pi-prompt-translator.db");
export const DEFAULT_CACHE_MAX_AGE_DAYS = 90;
export const DEFAULT_CACHE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const CACHE_BUSY_TIMEOUT_MS = 250;
const CACHE_ENTRY_OVERHEAD_BYTES = 16;

const TRANSLATION_SYSTEM_PROMPT = `You translate Chinese natural-language prompt text into English for a coding agent.

Return only the final translated prompt with no preamble, explanation, quote marks, or translation notes. Keep every non-Chinese literal segment exactly unchanged, including Markdown structure, headings, lists, tables, links, code fences, inline code, shell commands, paths, URLs, identifiers, variable names, flags, package names, and existing English text. Do not add or remove instructions. Translate only the Chinese natural-language prose needed to preserve the user's original intent.`;
const TRANSLATING_EDITOR_TEXT = "Translating prompt...";

type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[0];
type TranslationModel = Parameters<typeof complete>[0];
type CompletionResponse = Awaited<ReturnType<typeof complete>>;
type CompletionOptions = Parameters<typeof complete>[2];

export interface TranslatorConfig {
  model?: string;
  shortcut: Shortcut;
  cache: TranslationCacheConfig;
}

export interface TranslationCacheConfig {
  enabled: boolean;
  maxAgeDays: number;
  maxSizeBytes: number;
}

export interface TranslationCache {
  get(source: string): Promise<string | undefined>;
  set(source: string, translation: string): Promise<void>;
}

export interface TranslationSession {
  cache?: TranslationCache;
  inFlight?: boolean;
  pair?: TranslationPair;
}

export interface TranslationModelRegistry extends ModelRegistryLike<TranslationModel> {}

export interface TranslationUi {
  getEditorText(): string;
  setEditorText(text: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface TranslationContext {
  model?: TranslationModel;
  modelRegistry: TranslationModelRegistry;
  ui: TranslationUi;
}

export interface TranslationDependencies {
  complete(
    model: TranslationModel,
    request: Parameters<typeof complete>[1],
    options: CompletionOptions,
  ): Promise<CompletionResponse>;
  createCache(config: TranslationCacheConfig): TranslationCache;
  modelRoles?: ModelRolesConfig;
}

interface ResolvedTranslationModel {
  model: TranslationModel;
  auth: ModelAuth & { ok: true };
}

interface TranslationPair {
  source: string;
  translation: string;
}

interface TranslationCacheRow {
  translation: string;
}

interface CacheSizeRow {
  bytes: number;
}

interface CacheSourceRow {
  source: string;
}

export interface TranslationResolution {
  target?: ResolvedTranslationModel;
  thinkingLevel?: ThinkingLevel;
  configuredModelFailed: boolean;
}

type TranslationResult =
  | { kind: "success"; text: string; configuredModelFailed: boolean }
  | { kind: "unavailable"; configuredModelFailed: boolean }
  | { kind: "empty"; configuredModelFailed: boolean }
  | { kind: "failed"; configuredModelFailed: boolean };

const defaultDependencies: TranslationDependencies = {
  complete: complete as TranslationDependencies["complete"],
  createCache: (config) => createTranslationCache(config),
};

export function normalizeConfig(value: unknown): TranslatorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      shortcut: DEFAULT_SHORTCUT as Shortcut,
      cache: defaultCacheConfig(),
    };
  }

  const config = value as Record<string, unknown>;
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined;
  const shortcut =
    typeof config.shortcut === "string" && config.shortcut.trim()
      ? (config.shortcut.trim().toLowerCase() as Shortcut)
      : (DEFAULT_SHORTCUT as Shortcut);

  return { ...(model ? { model } : {}), shortcut, cache: normalizeCacheConfig(config.cache) };
}

function defaultCacheConfig(): TranslationCacheConfig {
  return {
    enabled: true,
    maxAgeDays: DEFAULT_CACHE_MAX_AGE_DAYS,
    maxSizeBytes: DEFAULT_CACHE_MAX_SIZE_BYTES,
  };
}

function normalizeCacheConfig(value: unknown): TranslationCacheConfig {
  const defaults = defaultCacheConfig();
  if (value === false) return { ...defaults, enabled: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;

  const cache = value as Record<string, unknown>;
  const maxAgeDays =
    typeof cache.maxAgeDays === "number" && Number.isSafeInteger(cache.maxAgeDays) && cache.maxAgeDays > 0
      ? cache.maxAgeDays
      : defaults.maxAgeDays;
  const maxSizeBytes =
    typeof cache.maxSizeBytes === "number" && Number.isSafeInteger(cache.maxSizeBytes) && cache.maxSizeBytes > 0
      ? cache.maxSizeBytes
      : defaults.maxSizeBytes;

  return {
    enabled: typeof cache.enabled === "boolean" ? cache.enabled : defaults.enabled,
    maxAgeDays,
    maxSizeBytes,
  };
}

export function loadConfig(path = CONFIG_PATH): TranslatorConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeConfig(undefined);
  }
}

export function shouldTranslateEditorText(draft: string): boolean {
  const trimmed = draft.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;

  return /\p{Script=Han}/u.test(draft);
}

export function createTranslationSession(): TranslationSession {
  return {};
}

export function createTranslationCache(
  config: TranslationCacheConfig,
  path = CACHE_PATH,
): TranslationCache {
  let database: Database | undefined;

  const getDatabase = (): Database => {
    database ??= openTranslationCache(path);
    return database;
  };

  return {
    async get(source) {
      if (!config.enabled) return undefined;

      const expiresAt = Date.now() - config.maxAgeDays * DAY_IN_MILLISECONDS;
      const row = getDatabase()
        .query(
          "SELECT translation FROM translations WHERE source = $source AND created_at > $expiresAt",
        )
        .get({ source, expiresAt }) as TranslationCacheRow | null;
      return row?.translation;
    },
    async set(source, translation) {
      if (!config.enabled) return;

      const database = getDatabase();
      const now = Date.now();
      const expiresAt = now - config.maxAgeDays * DAY_IN_MILLISECONDS;
      database.run("BEGIN IMMEDIATE");
      try {
        database.query("DELETE FROM translations WHERE created_at <= $expiresAt").run({ expiresAt });
        database
          .query(
            `INSERT INTO translations (source, translation, created_at)
             VALUES ($source, $translation, $createdAt)
             ON CONFLICT(source) DO UPDATE SET
               translation = excluded.translation,
               created_at = excluded.created_at`,
          )
          .run({ source, translation, createdAt: now });
        trimTranslationCache(database, config.maxSizeBytes);
        database.run("COMMIT");
        setCacheFilePermissions(path);
      } catch (error) {
        try {
          database.run("ROLLBACK");
        } catch {
          // Preserve the cache failure so the caller can fall back to a model request.
        }
        throw error;
      }
    },
  };
}

function openTranslationCache(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true, readwrite: true, strict: true });
  try {
    database.run(`PRAGMA busy_timeout = ${CACHE_BUSY_TIMEOUT_MS}`);
    if (path !== ":memory:") database.run("PRAGMA journal_mode = DELETE");
    database.run(`
      CREATE TABLE IF NOT EXISTS translations (
        source TEXT PRIMARY KEY,
        translation TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS translations_created_at ON translations(created_at);
    `);
    setCacheFilePermissions(path);
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Keep the original database initialization error.
    }
    throw error;
  }
}

function trimTranslationCache(database: Database, maxSizeBytes: number): void {
  while (translationCachePayloadSize(database) > maxSizeBytes) {
    const oldest = database
      .query("SELECT source FROM translations ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get() as CacheSourceRow | null;
    if (oldest === null) return;
    database.query("DELETE FROM translations WHERE source = $source").run({ source: oldest.source });
  }
}

function translationCachePayloadSize(database: Database): number {
  const row = database
    .query(
      `SELECT COALESCE(
         SUM(length(CAST(source AS BLOB)) + length(CAST(translation AS BLOB)) + $overhead),
         0
       ) AS bytes
       FROM translations`,
    )
    .get({ overhead: CACHE_ENTRY_OVERHEAD_BYTES }) as CacheSizeRow;
  return row.bytes;
}

function setCacheFilePermissions(path: string): void {
  if (path === ":memory:") return;
  for (const file of [path, `${path}-journal`]) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Cache permissions are best-effort on platforms that do not support POSIX modes.
    }
  }
}

function toggledTranslation(draft: string, session: TranslationSession): string | undefined {
  if (!session.pair) return undefined;
  if (draft === session.pair.source) return session.pair.translation;
  if (draft === session.pair.translation) return session.pair.source;

  session.pair = undefined;
  return undefined;
}

export async function resolveTranslationModel(
  configuredModel: string | undefined,
  currentModel: TranslationModel | undefined,
  registry: TranslationModelRegistry,
  modelRoles: ModelRolesConfig = loadModelRoles(),
): Promise<TranslationResolution> {
  const resolution = await resolveModelTarget({
    target: configuredModel,
    currentModel,
    modelRegistry: registry,
    config: modelRoles,
  });
  if (!isResolvedModelTarget(resolution)) {
    return { configuredModelFailed: Boolean(configuredModel) };
  }
  return {
    target: { model: resolution.model, auth: resolution.auth },
    ...(resolution.thinkingLevel ? { thinkingLevel: resolution.thinkingLevel } : {}),
    configuredModelFailed: Boolean(configuredModel && resolution.fallback),
  };
}

function textFromResponse(response: CompletionResponse): string {
  return response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

async function requestTranslation(
  draft: string,
  configuredModel: string | undefined,
  context: TranslationContext,
  dependencies: TranslationDependencies,
): Promise<TranslationResult> {
  const resolution = await resolveTranslationModel(
    configuredModel,
    context.model,
    context.modelRegistry,
    dependencies.modelRoles,
  );
  if (!resolution.target) {
    return { kind: "unavailable", configuredModelFailed: resolution.configuredModelFailed };
  }

  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: draft }],
    timestamp: Date.now(),
  };

  try {
    const response = await dependencies.complete(
      resolution.target.model,
      { systemPrompt: TRANSLATION_SYSTEM_PROMPT, messages: [message] },
      {
        apiKey: resolution.target.auth.apiKey,
        headers: resolution.target.auth.headers,
        env: resolution.target.auth.env,
        ...(resolution.thinkingLevel ? { reasoning: resolution.thinkingLevel } : {}),
      } as CompletionOptions,
    );

    const text = textFromResponse(response);
    return text
      ? { kind: "success", text, configuredModelFailed: resolution.configuredModelFailed }
      : { kind: "empty", configuredModelFailed: resolution.configuredModelFailed };
  } catch {
    return { kind: "failed", configuredModelFailed: resolution.configuredModelFailed };
  }
}

export async function translateEditorDraft(
  context: TranslationContext,
  config: TranslatorConfig,
  dependencies: TranslationDependencies = defaultDependencies,
  session: TranslationSession = createTranslationSession(),
): Promise<void> {
  if (session.inFlight) return;

  const originalDraft = context.ui.getEditorText();
  const draft = originalDraft.trim();
  const toggled = toggledTranslation(draft, session);
  if (toggled !== undefined) {
    context.ui.setEditorText(toggled);
    return;
  }

  if (!shouldTranslateEditorText(draft)) return;

  session.inFlight = true;
  try {
    const cache = (session.cache ??= dependencies.createCache(config.cache));
    try {
      const cachedTranslation = await cache.get(draft);
      if (cachedTranslation !== undefined) {
        if (context.ui.getEditorText() === originalDraft) {
          session.pair = { source: draft, translation: cachedTranslation };
          context.ui.setEditorText(cachedTranslation);
        }
        return;
      }
    } catch {
      // Cache failures must not prevent a new translation request.
    }

    if (context.ui.getEditorText() !== originalDraft) return;
    context.ui.setEditorText(TRANSLATING_EDITOR_TEXT);
    const result = await requestTranslation(draft, config.model, context, dependencies);

    if (result.configuredModelFailed) {
      context.ui.notify(
        result.kind === "success"
          ? "Configured translation model unavailable; using the current Pi model."
          : "Configured translation model is unavailable.",
        "warning",
      );
    }

    if (result.kind === "success") {
      try {
        await cache.set(draft, result.text);
      } catch {
        // The completed translation remains usable when cache persistence fails.
      }
      if (context.ui.getEditorText() === TRANSLATING_EDITOR_TEXT) {
        session.pair = { source: draft, translation: result.text };
        context.ui.setEditorText(result.text);
      }
      return;
    }

    if (context.ui.getEditorText() === TRANSLATING_EDITOR_TEXT) {
      context.ui.setEditorText(originalDraft);
    }

    if (result.kind === "unavailable") {
      context.ui.notify("No authenticated model is available for translation.", "error");
    } else if (result.kind === "empty") {
      context.ui.notify("Translation returned no text.", "warning");
    } else {
      context.ui.notify("Translation failed.", "error");
    }
  } finally {
    session.inFlight = false;
  }
}

export default function register(
  pi: ExtensionAPI,
  config = loadConfig(),
  dependencies: TranslationDependencies = defaultDependencies,
): void {
  const session = createTranslationSession();

  pi.registerShortcut(config.shortcut, {
    description: "Translate the Chinese editor draft to English",
    handler: async (shortcutContext) => {
      await translateEditorDraft(shortcutContext as unknown as TranslationContext, config, dependencies, session);
    },
  });
}
