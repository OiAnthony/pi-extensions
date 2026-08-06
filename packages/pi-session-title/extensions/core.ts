import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const STATE_ENTRY_TYPE = "pi-session-title-state";
export const CONFIG_PATH = join(getAgentDir(), "pi-session-title.json");
export const MAX_CONTEXT_LENGTH = 4_000;
export const MAX_RECENT_MESSAGES = 8;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SessionTitleStatus = "generated" | "failed" | "manual";
type CompletionModel = Parameters<typeof complete>[0];
type CompletionOptions = Parameters<typeof complete>[2];
type CompletionResponse = Awaited<ReturnType<typeof complete>>;

export interface SessionTitleState {
  version: 1;
  status: SessionTitleStatus;
  title?: string;
  lastEvaluatedUserTurnCount: number;
  updatedAt: string;
}

export interface SessionTitleConfig {
  enabled: boolean;
  model?: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
  maxTokens: number;
  maxLength: number;
  refreshTurns: number;
  terminalTitle: {
    enabled: boolean;
    template: string;
  };
  herdr: {
    enabled: boolean;
  };
}

export interface ModelReference {
  provider: string;
  modelId: string;
}

export interface TitleMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CompletedExchange {
  user: string;
  assistant: string;
}

export interface NamingContext {
  kind: "initial" | "refresh" | "manual";
  currentTitle?: string;
  messages: TitleMessage[];
}

export interface TitleModelRegistry {
  find(provider: string, modelId: string): CompletionModel | undefined;
  getApiKeyAndHeaders(model: CompletionModel): Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
}

export interface TitleCompletionContext {
  model?: CompletionModel;
  modelRegistry: TitleModelRegistry;
}

export interface TitleDependencies {
  complete(
    model: CompletionModel,
    request: Parameters<typeof complete>[1],
    options: CompletionOptions,
  ): Promise<CompletionResponse>;
}

export type TitleRequestResult =
  | { kind: "title"; title: string; model: string; configuredModelFailed: boolean }
  | { kind: "keep"; model: string; configuredModelFailed: boolean }
  | { kind: "failed"; model?: string; configuredModelFailed: boolean };

const DEFAULT_CONFIG: SessionTitleConfig = {
  enabled: true,
  thinkingLevel: "minimal",
  timeoutMs: 5_000,
  maxTokens: 40,
  maxLength: 48,
  refreshTurns: 4,
  terminalTitle: {
    enabled: true,
    template: "π {title} ({cwd})",
  },
  herdr: {
    enabled: true,
  },
};

const TITLE_SYSTEM_PROMPT = `Generate a concise session title for a coding-agent conversation.

Rules:
- Use the same language as the first user message.
- Return exactly one line of plain text and nothing else.
- Describe the specific task; avoid generic labels such as "code changes" or "problem solving".
- Do not use Markdown, quotation marks, or trailing punctuation.
- Keep the title within the requested character limit.
- When evaluating an existing title, return exactly KEEP if it remains accurate.`;

const ANSI_PATTERN = /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const TRAILING_PUNCTUATION = /[.!?,;:，。！？；：、…]+$/u;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const defaultDependencies: TitleDependencies = {
  complete: complete as TitleDependencies["complete"],
};

function positiveSafeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function normalizeConfig(value: unknown): SessionTitleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(DEFAULT_CONFIG);

  const input = value as Record<string, unknown>;
  const terminal = input.terminalTitle && typeof input.terminalTitle === "object" && !Array.isArray(input.terminalTitle)
    ? input.terminalTitle as Record<string, unknown>
    : {};
  const herdr = input.herdr && typeof input.herdr === "object" && !Array.isArray(input.herdr)
    ? input.herdr as Record<string, unknown>
    : {};
  const thinkingLevel = typeof input.thinkingLevel === "string" && THINKING_LEVELS.has(input.thinkingLevel as ThinkingLevel)
    ? input.thinkingLevel as ThinkingLevel
    : DEFAULT_CONFIG.thinkingLevel;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  const refreshTurns = typeof input.refreshTurns === "number"
    && Number.isSafeInteger(input.refreshTurns)
    && input.refreshTurns >= 0
    ? input.refreshTurns
    : DEFAULT_CONFIG.refreshTurns;

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_CONFIG.enabled,
    ...(model ? { model } : {}),
    thinkingLevel,
    timeoutMs: positiveSafeInteger(input.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    maxTokens: positiveSafeInteger(input.maxTokens, DEFAULT_CONFIG.maxTokens),
    maxLength: positiveSafeInteger(input.maxLength, DEFAULT_CONFIG.maxLength),
    refreshTurns,
    terminalTitle: {
      enabled: typeof terminal.enabled === "boolean" ? terminal.enabled : DEFAULT_CONFIG.terminalTitle.enabled,
      template: typeof terminal.template === "string" && terminal.template.trim()
        ? terminal.template
        : DEFAULT_CONFIG.terminalTitle.template,
    },
    herdr: {
      enabled: typeof herdr.enabled === "boolean" ? herdr.enabled : DEFAULT_CONFIG.herdr.enabled,
    },
  };
}

export function loadConfig(path = CONFIG_PATH): SessionTitleConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeConfig(undefined);
  }
}

export function parseModelReference(value: string | undefined): ModelReference | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const provider = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

export function cleanTitle(value: string, maxLength = DEFAULT_CONFIG.maxLength): string | undefined {
  let title = value
    .replace(ANSI_PATTERN, "")
    .split(/[\r\n]+/)
    .map((line) => line.replace(CONTROL_PATTERN, "").trim())
    .find(Boolean) ?? "";

  title = title.replace(/^#{1,6}\s*/u, "").replace(/^[-*+]\s+/u, "").trim();
  let previous: string | undefined;
  while (title && title !== previous) {
    previous = title;
    title = title
      .replace(/^(\*\*|__|~~|`)([\s\S]*)\1$/u, "$2")
      .replace(/^["'“”‘’«»]([\s\S]*)["'“”‘’«»]$/u, "$1")
      .trim();
  }

  title = title.replace(TRAILING_PUNCTUATION, "").trim();
  title = truncateCodePoints(title, maxLength).trim().replace(TRAILING_PUNCTUATION, "").trim();
  return title || undefined;
}

function firstContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isValidUserText(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && !trimmed.startsWith("/") && !trimmed.startsWith("!");
}

export function extractCompletedExchanges(entries: readonly unknown[]): CompletedExchange[] {
  const exchanges: CompletedExchange[] = [];
  let pending: CompletedExchange | undefined;

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry.type !== "message" || !entry.message) continue;

    if (entry.message.role === "user") {
      if (pending?.assistant) exchanges.push(pending);
      const text = contentText(entry.message.content);
      pending = isValidUserText(text) ? { user: text, assistant: "" } : undefined;
      continue;
    }

    if (entry.message.role === "assistant" && pending && !pending.assistant) {
      const text = firstContentText(entry.message.content);
      if (text) pending.assistant = text;
    }
  }

  if (pending?.assistant) exchanges.push(pending);
  return exchanges;
}

export function extractRecentMessages(entries: readonly unknown[], limit = MAX_RECENT_MESSAGES): TitleMessage[] {
  const messages: TitleMessage[] = [];
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
    const text = contentText(entry.message.content);
    if (!text || (entry.message.role === "user" && !isValidUserText(text))) continue;
    messages.push({ role: entry.message.role, text });
  }
  return messages.slice(-limit);
}

export function restoreState(entries: readonly unknown[]): SessionTitleState | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const rawEntry = entries[index];
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
    const data = entry.data as Partial<SessionTitleState>;
    if (data.version !== 1 || !["generated", "failed", "manual"].includes(data.status ?? "")) continue;
    if (!Number.isSafeInteger(data.lastEvaluatedUserTurnCount) || data.lastEvaluatedUserTurnCount! < 0) continue;
    return {
      version: 1,
      status: data.status!,
      ...(typeof data.title === "string" && data.title ? { title: data.title } : {}),
      lastEvaluatedUserTurnCount: data.lastEvaluatedUserTurnCount!,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
    };
  }
  return undefined;
}

export function nextAutomaticEvaluation(
  state: SessionTitleState | undefined,
  userTurnCount: number,
  refreshTurns: number,
): "initial" | "refresh" | undefined {
  if (state?.status === "manual" || userTurnCount < 1) return undefined;
  if (!state) return userTurnCount === 1 ? "initial" : undefined;
  if (refreshTurns === 0) return undefined;
  return userTurnCount >= state.lastEvaluatedUserTurnCount + refreshTurns ? "refresh" : undefined;
}

function trimInitialContext(exchange: CompletedExchange): TitleMessage[] {
  const user = truncateCodePoints(exchange.user, MAX_CONTEXT_LENGTH);
  const remaining = Math.max(0, MAX_CONTEXT_LENGTH - codePointLength(user));
  const assistant = truncateCodePoints(exchange.assistant, remaining);
  return [
    { role: "user", text: user },
    ...(assistant ? [{ role: "assistant" as const, text: assistant }] : []),
  ];
}

export function trimRecentContext(messages: readonly TitleMessage[], maxLength = MAX_CONTEXT_LENGTH): TitleMessage[] {
  const selected: TitleMessage[] = [];
  let remaining = maxLength;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index]!;
    const chars = Array.from(message.text);
    const text = chars.length <= remaining ? message.text : chars.slice(chars.length - remaining).join("");
    selected.unshift({ ...message, text });
    remaining -= codePointLength(text);
  }
  return selected;
}

export function buildNamingContext(
  kind: NamingContext["kind"],
  entries: readonly unknown[],
  currentTitle?: string,
): NamingContext | undefined {
  if (kind === "initial") {
    const first = extractCompletedExchanges(entries)[0];
    return first ? { kind, messages: trimInitialContext(first) } : undefined;
  }
  const messages = trimRecentContext(extractRecentMessages(entries));
  return messages.length ? { kind, currentTitle, messages } : undefined;
}

function formatPrompt(context: NamingContext, maxLength: number): string {
  const conversation = context.messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n\n");
  const current = context.currentTitle ? `Current title: ${context.currentTitle}\n\n` : "";
  return `${current}Maximum title length: ${maxLength} Unicode code points.\n\nConversation:\n${conversation}`;
}

function modelKey(model: CompletionModel): string {
  return `${model.provider}/${model.id}`;
}

async function completeWithTimeout(
  model: CompletionModel,
  auth: { apiKey: string; headers?: Record<string, string>; env?: Record<string, string> },
  prompt: string,
  config: SessionTitleConfig,
  dependencies: TitleDependencies,
  outerSignal?: AbortSignal,
): Promise<CompletionResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, config.timeoutMs);
  timeout.unref?.();
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  try {
    const completion = dependencies.complete(
      model,
      { systemPrompt: TITLE_SYSTEM_PROMPT, messages: [message] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: config.maxTokens,
        reasoning: config.thinkingLevel,
        signal: controller.signal,
        cacheRetention: "none",
      } as CompletionOptions,
    );
    return await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Session title request aborted.")), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", abort);
  }
}

function responseText(response: CompletionResponse): string {
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function requestTitle(
  namingContext: NamingContext,
  context: TitleCompletionContext,
  config: SessionTitleConfig,
  signal?: AbortSignal,
  dependencies: TitleDependencies = defaultDependencies,
): Promise<TitleRequestResult> {
  const configuredReference = parseModelReference(config.model);
  let configuredModelFailed = Boolean(config.model && !configuredReference);
  const candidates: Array<{ model: CompletionModel; configured: boolean }> = [];
  if (configuredReference) {
    const configured = context.modelRegistry.find(configuredReference.provider, configuredReference.modelId);
    if (configured) candidates.push({ model: configured, configured: true });
    else configuredModelFailed = true;
  }
  if (context.model && !candidates.some(({ model }) => modelKey(model) === modelKey(context.model!))) {
    candidates.push({ model: context.model, configured: false });
  }

  const prompt = formatPrompt(namingContext, config.maxLength);
  let lastModel: string | undefined;
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    lastModel = modelKey(candidate.model);
    try {
      const auth = await context.modelRegistry.getApiKeyAndHeaders(candidate.model);
      if (!auth.ok || !auth.apiKey) {
        if (candidate.configured) configuredModelFailed = true;
        continue;
      }
      const response = await completeWithTimeout(
        candidate.model,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
        prompt,
        config,
        dependencies,
        signal,
      );
      const raw = responseText(response);
      if (namingContext.kind !== "initial" && raw.trim() === "KEEP") {
        return { kind: "keep", model: lastModel, configuredModelFailed };
      }
      const title = cleanTitle(raw, config.maxLength);
      if (title) return { kind: "title", title, model: lastModel, configuredModelFailed };
      if (candidate.configured) configuredModelFailed = true;
    } catch {
      if (candidate.configured) configuredModelFailed = true;
    }
  }
  return { kind: "failed", model: lastModel, configuredModelFailed };
}

export function createState(
  status: SessionTitleStatus,
  lastEvaluatedUserTurnCount: number,
  title?: string,
): SessionTitleState {
  return {
    version: 1,
    status,
    ...(title ? { title } : {}),
    lastEvaluatedUserTurnCount,
    updatedAt: new Date().toISOString(),
  };
}

export function renderTerminalTitle(template: string, title: string, cwd: string): string {
  return template
    .replaceAll("{title}", title)
    .replaceAll("{cwd}", basename(cwd))
    .replace(/\{(?!title\}|cwd\})[^}]*\}/g, "")
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .trim();
}

export function configuredModelLabel(config: SessionTitleConfig): string {
  return config.model ?? "current Pi model";
}
