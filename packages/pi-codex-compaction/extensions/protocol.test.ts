import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendCompactionTrigger,
  collectCompactionSse,
  prepareRemoteCompactionPayload,
  rewriteCheckpointMarker,
} from "./protocol.js";

const encoder = new TextEncoder();
function fragmented(text: string, size = 1): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size) {
        controller.enqueue(bytes.slice(index, index + size));
      }
      controller.close();
    },
  });
}
function validSse(content = "opaque"): string {
  const item = { type: "compaction", encrypted_content: content };
  return `: ping\r\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\r\n\r\n`;
}

test("collects one deduplicated item from fragmented SSE", async () => {
  const result = await collectCompactionSse(fragmented(validSse(), 2));
  assert.equal(result.item.encrypted_content, "opaque");
  assert.ok(result.completedResponse);
});

test("rejects malformed SSE", async () => {
  await assert.rejects(collectCompactionSse(fragmented("data: {bad}\n\n")), /malformed SSE/);
});

test("rejects SSE without a compaction item", async () => {
  await assert.rejects(
    collectCompactionSse(fragmented('data: {"type":"response.completed","response":{"output":[]}}\n\n')),
    /returned 0 distinct/,
  );
});

test("rejects distinct duplicate compaction items", async () => {
  await assert.rejects(
    collectCompactionSse(fragmented(
      'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"a"}}\n\n' +
      'data: {"type":"response.completed","response":{"output":[{"type":"compaction","encrypted_content":"b"}]}}\n\n',
    )),
    /returned 2 distinct/,
  );
});

test("rejects oversized and aborted SSE", async () => {
  await assert.rejects(collectCompactionSse(fragmented(validSse()), { maxBytes: 10 }), /size limit/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectCompactionSse(fragmented(validSse()), { signal: controller.signal }), /aborted/i);
});

test("replays one marker and appends one final trigger", () => {
  const marker = "checkpoint";
  const payload = {
    model: "gpt",
    input: [
      { role: "user", content: [{ type: "input_text", text: marker }] },
      { role: "user", content: [{ type: "input_text", text: "later" }] },
    ],
  };
  const replacement = [{ type: "compaction", encrypted_content: "prior" }];
  const prepared = prepareRemoteCompactionPayload(payload, { marker, replacementHistory: replacement });
  assert.deepEqual(prepared.input, [replacement[0], payload.input[1], { type: "compaction_trigger" }]);
  assert.equal(payload.input.length, 2);
  assert.throws(() => rewriteCheckpointMarker({ input: [] }, marker, replacement), /0 checkpoint markers/);
  assert.throws(() => appendCompactionTrigger({ input: [{ type: "compaction_trigger" }] }), /already contains/);
});
