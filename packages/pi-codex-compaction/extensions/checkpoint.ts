import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type JsonObject, validateCompactionItem } from "./protocol.js";
import {
  CODEX_API,
  OPENAI_RESPONSES_API,
  normalizeUrl,
  type RemoteCompactionApi,
} from "./capability.js";

export const CHECKPOINT_KIND = "pi-codex-compaction";
export const CHECKPOINT_VERSION = 1;
export const REPLACEMENT_TOKEN_BUDGET = 64_000;
export const REPLACEMENT_BYTE_BUDGET = 8 * 1024 * 1024;
const MAX_MEDIA_ITEM_BYTES = 2 * 1024 * 1024;

export interface ProviderIdentity {
  provider: string;
  api: RemoteCompactionApi;
  modelId: string;
  baseUrl: string;
  endpoint: string;
}

export interface CodexCheckpointDetails extends ProviderIdentity {
  kind: typeof CHECKPOINT_KIND;
  version: typeof CHECKPOINT_VERSION;
  checkpointId: string;
  protocol: "remote-compaction-v2";
  replacementHistory: JsonObject[];
  keptMessageFingerprints: string[];
  createdAt: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function fingerprintMessage(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify(stableValue(message))).digest("hex");
}

export function checkpointMarker(checkpointId: string): string {
  return [
    `[PI_CODEX_REMOTE_CHECKPOINT:${checkpointId}]`,
    "Opaque checkpoint injection failed. Do not infer missing history; tell the user to re-enable",
    "@oipsanthony/pi-codex-compaction with the checkpoint's provider and model.",
  ].join(" ");
}

export function fallbackSummary(checkpointId: string): string {
  return [
    `Codex Remote Compaction V2 checkpoint ${checkpointId} stores the older history opaquely.`,
    "Full replay requires @oipsanthony/pi-codex-compaction and the original provider endpoint and model.",
    "Without them, only Pi's retained recent messages remain available.",
  ].join(" ");
}

function markerMessage(checkpointId: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: checkpointMarker(checkpointId) }],
    timestamp,
  };
}

export function parseCheckpointDetails(value: unknown): CodexCheckpointDetails | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.kind !== CHECKPOINT_KIND ||
    value.version !== CHECKPOINT_VERSION ||
    typeof value.checkpointId !== "string" ||
    value.checkpointId.length < 8 ||
    typeof value.provider !== "string" ||
    !value.provider ||
    (value.api !== CODEX_API && value.api !== OPENAI_RESPONSES_API) ||
    typeof value.modelId !== "string" ||
    !value.modelId ||
    typeof value.baseUrl !== "string" ||
    typeof value.endpoint !== "string" ||
    value.protocol !== "remote-compaction-v2" ||
    !Array.isArray(value.replacementHistory) ||
    !Array.isArray(value.keptMessageFingerprints) ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  try {
    if (
      normalizeUrl(value.baseUrl) !== value.baseUrl ||
      normalizeUrl(value.endpoint) !== value.endpoint ||
      new URL(value.baseUrl).origin !== new URL(value.endpoint).origin
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (
    value.replacementHistory.length === 0 ||
    !value.replacementHistory.every(isObject) ||
    !value.keptMessageFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    ) ||
    serializedBytes(value.replacementHistory) > REPLACEMENT_BYTE_BUDGET
  ) {
    return undefined;
  }
  try {
    validateCompactionItem(value.replacementHistory.at(-1));
  } catch {
    return undefined;
  }
  return structuredClone(value) as unknown as CodexCheckpointDetails;
}

export function latestCheckpoint(
  entries: readonly SessionEntry[],
): { entry: CompactionEntry<CodexCheckpointDetails>; details: CodexCheckpointDetails } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    const details = parseCheckpointDetails(entry.details);
    return details
      ? { entry: entry as CompactionEntry<CodexCheckpointDetails>, details }
      : undefined;
  }
  return undefined;
}

export function projectCheckpointContext(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const summary = fallbackSummary(details.checkpointId);
  const summaryIndex = messages.findIndex(
    (message) => message.role === "compactionSummary" && message.summary === summary,
  );
  if (summaryIndex < 0) return undefined;
  const keptStart = summaryIndex + 1;
  const keptEnd = keptStart + details.keptMessageFingerprints.length;
  if (keptEnd > messages.length) return undefined;
  for (let index = keptStart; index < keptEnd; index++) {
    if (
      fingerprintMessage(messages[index]) !== details.keptMessageFingerprints[index - keptStart]
    ) {
      return undefined;
    }
  }
  return [
    ...messages.slice(0, summaryIndex),
    markerMessage(details.checkpointId, messages[summaryIndex].timestamp),
    ...messages.slice(keptEnd),
  ];
}

function rawText(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) =>
      isObject(part) && part.type === "input_text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function hasMedia(item: JsonObject): boolean {
  return (
    Array.isArray(item.content) &&
    item.content.some((part) => isObject(part) && part.type === "input_image")
  );
}

function truncateTextItem(item: JsonObject, maxChars: number): JsonObject | undefined {
  if (!Array.isArray(item.content) || maxChars <= 32) return undefined;
  let remaining = maxChars - 16;
  const content = [...item.content].reverse().flatMap((part) => {
    if (
      !isObject(part) ||
      part.type !== "input_text" ||
      typeof part.text !== "string" ||
      remaining <= 0
    ) {
      return [];
    }
    const text = part.text.slice(-remaining);
    remaining -= text.length;
    return [{ ...part, text: `[truncated]\n${text}` }];
  });
  return content.length ? { ...item, content: content.reverse() } : undefined;
}

export function buildReplacementHistory(
  input: readonly unknown[],
  compactionItem: JsonObject,
  options: { tokenBudget?: number; byteBudget?: number } = {},
): JsonObject[] {
  const tokenBudget = options.tokenBudget ?? REPLACEMENT_TOKEN_BUDGET;
  const byteBudget = options.byteBudget ?? REPLACEMENT_BYTE_BUDGET;
  const opaque = validateCompactionItem(compactionItem);
  let remainingBytes = byteBudget - serializedBytes(opaque);
  let remainingChars = tokenBudget * 4;
  if (remainingBytes <= 0) throw new Error("Opaque compaction item exceeds replacement history budget");
  const retainedNewestFirst: JsonObject[] = [];
  const candidates = input.filter(
    (item): item is JsonObject =>
      isObject(item) && item.role === "user" && item.type !== "compaction_trigger",
  );
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    const bytes = serializedBytes(candidate);
    if (hasMedia(candidate) && bytes > MAX_MEDIA_ITEM_BYTES) continue;
    const text = rawText(candidate);
    let retained = candidate;
    if (text.length > remainingChars) {
      if (hasMedia(candidate)) continue;
      const truncated = truncateTextItem(candidate, remainingChars);
      if (!truncated) continue;
      retained = truncated;
    }
    if (serializedBytes(retained) > remainingBytes) {
      if (hasMedia(retained)) continue;
      const truncated = truncateTextItem(
        retained,
        Math.min(remainingChars, Math.max(0, remainingBytes - 128)),
      );
      if (!truncated || serializedBytes(truncated) > remainingBytes) continue;
      retained = truncated;
    }
    retainedNewestFirst.push(structuredClone(retained));
    remainingBytes -= serializedBytes(retained);
    remainingChars -= Math.min(remainingChars, rawText(retained).length);
    if (remainingBytes <= 128 || remainingChars <= 32) break;
  }
  return [...retainedNewestFirst.reverse(), opaque];
}

export function createCheckpointDetails(input: {
  identity: ProviderIdentity;
  replacementHistory: JsonObject[];
  keptMessages: readonly AgentMessage[];
  checkpointId?: string;
  createdAt?: string;
}): CodexCheckpointDetails {
  const details: CodexCheckpointDetails = {
    kind: CHECKPOINT_KIND,
    version: CHECKPOINT_VERSION,
    checkpointId: input.checkpointId ?? randomUUID(),
    ...input.identity,
    protocol: "remote-compaction-v2",
    replacementHistory: structuredClone(input.replacementHistory),
    keptMessageFingerprints: input.keptMessages.map(fingerprintMessage),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const parsed = parseCheckpointDetails(details);
  if (!parsed) throw new Error("Created an invalid Codex checkpoint");
  return parsed;
}
