import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  isResolvedModelTarget,
  loadModelRoles,
  normalizeModelRoles,
  resolveModelTarget,
  selectThinkingLevel,
  type ModelAuth,
  type ModelRegistryLike,
  type ModelRolesConfig,
} from "./index.js";

interface Model {
  provider: string;
  id: string;
  label?: string;
}

const current: Model = { provider: "test", id: "current" };
const direct: Model = { provider: "openrouter", id: "anthropic/claude-sonnet-4" };

function config(roles: Record<string, string>, cycleOrder?: string[]): ModelRolesConfig {
  return normalizeModelRoles({ roles, ...(cycleOrder ? { cycleOrder } : {}) });
}

function registry(options: {
  models?: Model[];
  auth?: (model: Model) => Promise<ModelAuth>;
  find?: (provider: string, modelId: string) => Model | undefined;
} = {}): ModelRegistryLike<Model> {
  const models = options.models ?? [current, direct];
  return {
    find: options.find ?? ((provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId)),
    getApiKeyAndHeaders: options.auth ?? (async () => ({ ok: true, apiKey: "key" })),
  };
}

describe("model role configuration", () => {
  test("preserves declaration order and accepts arbitrary case-sensitive roles", () => {
    const loaded = normalizeModelRoles({
      roles: {
        small: "test/current",
        Review: "openrouter/anthropic/claude-sonnet-4:xhigh",
        "worker.long": "@Review:max",
      },
    });
    assert.deepEqual(loaded.roleOrder, ["small", "Review", "worker.long"]);
    assert.deepEqual(loaded.cycleOrder, loaded.roleOrder);
    assert.equal(loaded.roles.review, undefined);
    assert.deepEqual(loaded.issues, []);
  });

  test("keeps valid entries and reports invalid roles and cycle entries", () => {
    const loaded = normalizeModelRoles({
      roles: {
        valid: "test/current",
        "@bad": "test/current",
        empty: "",
        object: { model: "test/current" },
        badRef: "@valid:turbo",
      },
      cycleOrder: ["valid", "missing", "valid", 3],
    });
    assert.deepEqual(loaded.roles, { valid: "test/current" });
    assert.deepEqual(loaded.cycleOrder, ["valid"]);
    assert.equal(loaded.issues.filter((issue) => issue.code === "invalid-role").length, 4);
    assert.equal(loaded.issues.filter((issue) => issue.code === "invalid-cycle-order").length, 3);
  });

  test("distinguishes missing files from malformed files and structures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-model-roles-"));
    try {
      assert.deepEqual(loadModelRoles(join(directory, "missing.json")).issues, []);
      const malformed = join(directory, "malformed.json");
      await writeFile(malformed, "{");
      assert.equal(loadModelRoles(malformed).issues[0]?.code, "invalid-json");
      assert.equal(normalizeModelRoles([]).issues[0]?.code, "invalid-root");
      assert.equal(normalizeModelRoles({ roles: [] }).issues[0]?.code, "invalid-roles");
      assert.equal(normalizeModelRoles({ roles: {}, cycleOrder: "small" }).issues[0]?.code, "invalid-cycle-order");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("model target resolution", () => {
  test("resolves a role chain, OpenRouter model ID, and outer thinking override", async () => {
    const result = await resolveModelTarget({
      target: "@writer",
      currentModel: current,
      modelRegistry: registry(),
      config: config({ base: "openrouter/anthropic/claude-sonnet-4:high", writer: "@base:xhigh" }),
    });
    assert.equal(isResolvedModelTarget(result), true);
    if (!isResolvedModelTarget(result)) return;
    assert.equal(result.model, direct);
    assert.equal(result.modelId, "openrouter/anthropic/claude-sonnet-4");
    assert.equal(result.thinkingLevel, "xhigh");
    assert.deepEqual(result.roleChain, ["writer", "base"]);
    assert.equal(result.source, "role");
    assert.equal(result.fallback, false);
  });

  test("inherits inner thinking and preserves missing thinking", async () => {
    const inherited = await resolveModelTarget({
      target: "@review",
      modelRegistry: registry(),
      config: config({ base: "test/current:high", review: "@base" }),
    });
    assert.equal(isResolvedModelTarget(inherited) && inherited.thinkingLevel, "high");

    const omitted = await resolveModelTarget({
      target: "@review",
      modelRegistry: registry(),
      config: config({ base: "test/current", review: "@base" }),
    });
    assert.equal(isResolvedModelTarget(omitted) && omitted.thinkingLevel, undefined);
  });

  test("uses an exact colon-suffixed model ID before parsing thinking", async () => {
    const exact: Model = { provider: "test", id: "model:high" };
    const result = await resolveModelTarget({
      target: "test/model:high",
      modelRegistry: registry({ models: [exact] }),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(result) && result.model, exact);
    assert.equal(isResolvedModelTarget(result) && result.thinkingLevel, undefined);
  });

  test("diagnoses unknown roles, self cycles, multi-role cycles, and illegal suffixes", async () => {
    const cases: Array<{
      target: string;
      roles: Record<string, string>;
      code: string;
      chain: string[];
    }> = [
      { target: "@missing", roles: {}, code: "unknown-role", chain: ["missing"] },
      { target: "@self", roles: { self: "@self" }, code: "role-cycle", chain: ["self", "self"] },
      { target: "@one", roles: { one: "@two", two: "@one" }, code: "role-cycle", chain: ["one", "two", "one"] },
      { target: "@small:turbo", roles: { small: "test/current" }, code: "invalid-thinking-level", chain: [] },
    ];
    for (const item of cases) {
      const result = await resolveModelTarget({
        target: item.target,
        modelRegistry: registry(),
        config: config(item.roles),
        allowCurrentFallback: false,
      });
      assert.equal(isResolvedModelTarget(result), false);
      assert.equal(result.issues[0]?.code, item.code);
      assert.deepEqual(result.issues[0]?.chain ?? result.roleChain, item.chain);
    }
  });

  test("falls back to the current model after missing model or failed auth", async () => {
    const missing = await resolveModelTarget({
      target: "missing/model",
      currentModel: current,
      modelRegistry: registry(),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(missing) && missing.model, current);
    assert.equal(isResolvedModelTarget(missing) && missing.fallback, true);
    assert.equal(missing.issues[0]?.code, "model-not-found");

    const authFailure = await resolveModelTarget({
      target: "openrouter/anthropic/claude-sonnet-4",
      currentModel: current,
      modelRegistry: registry({
        auth: async (model) => model === direct ? { ok: false } : { ok: true, apiKey: "current" },
      }),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(authFailure) && authFailure.model, current);
    assert.equal(authFailure.issues[0]?.code, "authentication-failed");
  });

  test("authenticates a configured target matching current only once", async () => {
    let authCalls = 0;
    const result = await resolveModelTarget({
      target: "test/current",
      currentModel: current,
      modelRegistry: registry({
        find: () => undefined,
        auth: async () => {
          authCalls++;
          return { ok: true, apiKey: "key" };
        },
      }),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(result) && result.model, current);
    assert.equal(authCalls, 1);
  });

  test("uses auth.ok without requiring an API key and preserves auth metadata", async () => {
    const result = await resolveModelTarget({
      target: "test/current",
      modelRegistry: registry({
        auth: async () => ({ ok: true, apiKey: "", headers: { "x-test": "yes" }, env: { TOKEN: "value" } }),
      }),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(result), true);
    if (!isResolvedModelTarget(result)) return;
    assert.equal(result.auth.apiKey, "");
    assert.deepEqual(result.auth.headers, { "x-test": "yes" });
    assert.deepEqual(result.auth.env, { TOKEN: "value" });
  });

  test("contains registry exceptions and returns no model when fallback is unavailable", async () => {
    const result = await resolveModelTarget({
      target: "test/current",
      modelRegistry: registry({ find: () => { throw new Error("registry down"); } }),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(result), false);
    assert.equal(result.issues[0]?.code, "registry-error");
  });

  test("uses current model directly when target is omitted", async () => {
    const result = await resolveModelTarget({
      currentModel: current,
      modelRegistry: registry(),
      config: config({}),
    });
    assert.equal(isResolvedModelTarget(result) && result.source, "current");
    assert.equal(isResolvedModelTarget(result) && result.fallback, false);
  });
});

test("thinking priority is explicit, role, then caller default", () => {
  assert.equal(selectThinkingLevel("high", "max", "medium"), "high");
  assert.equal(selectThinkingLevel(undefined, "max", "medium"), "max");
  assert.equal(selectThinkingLevel(undefined, undefined, "medium"), "medium");
  assert.equal(selectThinkingLevel(undefined, undefined, undefined), undefined);
});
