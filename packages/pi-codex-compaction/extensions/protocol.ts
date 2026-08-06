export const MAX_SSE_BYTES = 8 * 1024 * 1024;
export const MAX_COMPACTION_ITEM_BYTES = 2 * 1024 * 1024;

export type JsonObject = Record<string, unknown>;

export class CodexCompactionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCompactionProtocolError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCompactionItem(
  value: unknown,
  maxBytes = MAX_COMPACTION_ITEM_BYTES,
): JsonObject {
  if (
    !isObject(value) ||
    value.type !== "compaction" ||
    typeof value.encrypted_content !== "string" ||
    !value.encrypted_content
  ) {
    throw new CodexCompactionProtocolError(
      "Remote response did not contain a valid compaction item",
    );
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    throw new CodexCompactionProtocolError("Remote compaction item exceeded the size limit");
  }
  return structuredClone(value);
}

export interface CollectedCompaction {
  item: JsonObject;
  completedResponse?: JsonObject;
}

function compactionItemsFromEvent(event: JsonObject): unknown[] {
  const items: unknown[] = [];
  if (event.type === "response.output_item.done" && isObject(event.item)) items.push(event.item);
  if (
    event.type === "response.completed" &&
    isObject(event.response) &&
    Array.isArray(event.response.output)
  ) {
    items.push(...event.response.output);
  }
  return items.filter((item) => isObject(item) && item.type === "compaction");
}

export async function collectCompactionSse(
  stream: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; maxBytes?: number; maxItemBytes?: number } = {},
): Promise<CollectedCompaction> {
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  let dataLines: string[] = [];
  let completedResponse: JsonObject | undefined;
  const items = new Map<string, JsonObject>();

  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
  };
  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodexCompactionProtocolError("Remote compaction returned malformed SSE JSON");
    }
    if (!isObject(parsed)) return;
    if (parsed.type === "response.completed") {
      completedResponse = isObject(parsed.response) ? parsed.response : {};
    }
    for (const candidate of compactionItemsFromEvent(parsed)) {
      const item = validateCompactionItem(candidate, options.maxItemBytes);
      items.set(JSON.stringify(item), item);
    }
  };
  const processLine = (line: string) => {
    if (!line) return dispatch();
    if (line.startsWith(":")) return;
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  };

  try {
    while (true) {
      checkAbort();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > (options.maxBytes ?? MAX_SSE_BYTES)) {
        throw new CodexCompactionProtocolError("Remote compaction stream exceeded the size limit");
      }
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending) processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
    dispatch();
    checkAbort();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (!completedResponse) {
    throw new CodexCompactionProtocolError(
      "Remote compaction stream ended without response.completed",
    );
  }
  if (items.size !== 1) {
    throw new CodexCompactionProtocolError(
      `Remote compaction returned ${items.size} distinct compaction items; expected exactly one`,
    );
  }
  return { item: [...items.values()][0], completedResponse };
}

function markerText(item: unknown): string | undefined {
  if (
    !isObject(item) ||
    item.role !== "user" ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  ) {
    return undefined;
  }
  const content = item.content[0];
  return isObject(content) &&
    content.type === "input_text" &&
    typeof content.text === "string"
    ? content.text
    : undefined;
}

export function rewriteCheckpointMarker(
  payload: unknown,
  marker: string,
  replacementHistory: readonly unknown[],
): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex payload is missing an input array");
  }
  const matches = payload.input
    .map((item, index) => (markerText(item) === marker ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new CodexCompactionProtocolError(
      `Provider payload contained ${matches.length} checkpoint markers; expected exactly one`,
    );
  }
  const index = matches[0];
  return {
    ...payload,
    input: [
      ...payload.input.slice(0, index),
      ...structuredClone(replacementHistory),
      ...payload.input.slice(index + 1),
    ],
  };
}

export function appendCompactionTrigger(payload: unknown): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex payload is missing an input array");
  }
  if (payload.input.some((item) => isObject(item) && item.type === "compaction_trigger")) {
    throw new CodexCompactionProtocolError("Provider payload already contains a compaction trigger");
  }
  return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
}

export function prepareRemoteCompactionPayload(
  payload: unknown,
  checkpoint?: { marker: string; replacementHistory: readonly unknown[] },
): JsonObject {
  return appendCompactionTrigger(
    checkpoint
      ? rewriteCheckpointMarker(payload, checkpoint.marker, checkpoint.replacementHistory)
      : payload,
  );
}

export function hasCheckpointMarker(payload: unknown, marker: string): boolean {
  return (
    isObject(payload) &&
    Array.isArray(payload.input) &&
    payload.input.some((item) => markerText(item) === marker)
  );
}
