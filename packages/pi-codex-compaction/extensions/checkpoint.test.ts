import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildReplacementHistory,
  createCheckpointDetails,
  fallbackSummary,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
  type ProviderIdentity,
} from "./checkpoint.js";

const identity: ProviderIdentity = {
  provider: "custom-codex",
  api: "openai-codex-responses",
  modelId: "gpt-5.6",
  baseUrl: "https://codex-gateway.example/v1",
  endpoint: "https://codex-gateway.example/v1/responses",
};
const opaque = { type: "compaction", encrypted_content: "opaque" };
function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}
function rawUser(text: string) {
  return { role: "user", content: [{ type: "input_text", text }] };
}
function checkpoint(kept: AgentMessage[] = [user("kept", 2)], id = "checkpoint-123") {
  return createCheckpointDetails({
    identity,
    replacementHistory: [rawUser("old"), opaque],
    keptMessages: kept,
    checkpointId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("persists and validates the complete provider endpoint identity", () => {
  const details = checkpoint();
  assert.deepEqual(parseCheckpointDetails(details), details);
  for (const patch of [
    { provider: "other" },
    { modelId: "other" },
    {
      baseUrl: "https://other.example/v1",
      endpoint: "https://other.example/v1/responses",
    },
  ]) {
    assert.ok(parseCheckpointDetails({ ...details, ...patch }));
  }
  assert.equal(
    parseCheckpointDetails({ ...details, baseUrl: "https://other.example/v1" }),
    undefined,
  );
  assert.equal(
    parseCheckpointDetails({ ...details, endpoint: "https://other.example/v1/responses" }),
    undefined,
  );
  assert.equal(parseCheckpointDetails({ ...details, api: "anthropic-messages" }), undefined);
  assert.equal(parseCheckpointDetails({ ...details, version: 2 }), undefined);
  assert.doesNotMatch(JSON.stringify(details), /authorization|apiKey|token/i);
});

test("builds bounded replacement history with the opaque item last", () => {
  const history = buildReplacementHistory([rawUser("oldest"), rawUser("newest")], opaque, {
    tokenBudget: 2,
    byteBudget: 2048,
  });
  assert.equal(history.at(-1)?.type, "compaction");
  assert.match(JSON.stringify(history), /newest/);
});

test("projects exact retained messages for resume and rejects corrupt state", () => {
  const kept = user("kept", 2);
  const details = checkpoint([kept]);
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: 1,
  };
  const after = user("after", 3);
  const projected = projectCheckpointContext([summary, kept, after], details);
  assert.equal(projected?.length, 2);
  assert.match(JSON.stringify(projected?.[0]), /PI_CODEX_REMOTE_CHECKPOINT/);
  assert.equal(projectCheckpointContext([summary, user("changed", 2), after], details), undefined);
  assert.equal(parseCheckpointDetails({ ...details, replacementHistory: [] }), undefined);
});

test("selects checkpoints from the active fork only", () => {
  const first = checkpoint([], "checkpoint-first");
  const second = checkpoint([], "checkpoint-second");
  const entry = (id: string, details: ReturnType<typeof checkpoint>, parentId: string | null): CompactionEntry => ({
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: fallbackSummary(details.checkpointId),
    firstKeptEntryId: "kept",
    tokensBefore: 10,
    details,
  });
  const branch = [entry("first", first, null), entry("second", second, "first")] as SessionEntry[];
  assert.equal(latestCheckpoint(branch)?.details.checkpointId, "checkpoint-second");
  assert.equal(latestCheckpoint(branch.slice(0, 1))?.details.checkpointId, "checkpoint-first");
  const native = { ...entry("native", second, "second"), details: undefined, summary: "native" };
  assert.equal(latestCheckpoint([...branch, native]), undefined);
});
