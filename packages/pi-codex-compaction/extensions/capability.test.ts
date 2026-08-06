import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { capableModel, deriveEndpoint, normalizeUrl } from "./capability.js";

function model(overrides: Record<string, unknown> = {}): Model<Api> {
  return {
    id: "gpt-example",
    name: "GPT Example",
    api: "openai-codex-responses",
    provider: "custom-codex",
    baseUrl: "https://codex-gateway.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    ...overrides,
  } as Model<Api>;
}

const configuredCompat = {
  remoteCompaction: {
    protocol: "v2",
    endpoint: "https://codex-gateway.example/v1/responses",
  },
};

test("enables the official OpenAI Codex endpoint without model metadata", () => {
  const supported = capableModel(
    model({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      compat: undefined,
    }),
  );
  assert.equal(supported?.capability.protocol, "v2");
  assert.equal(
    supported?.capability.endpoint,
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("derives an OpenAI Responses endpoint from models.json capability metadata", () => {
  const supported = capableModel(
    model({
      api: "openai-responses",
      compat: { remoteCompaction: { protocol: "v2" } },
    }),
  );
  assert.equal(supported?.model.api, "openai-responses");
  assert.equal(supported?.baseUrl, "https://codex-gateway.example/v1");
  assert.deepEqual(supported?.capability, {
    protocol: "v2",
    endpoint: "https://codex-gateway.example/v1/responses",
  });
});

test("adds a v1 path when deriving an OpenAI Responses endpoint", () => {
  assert.equal(
    deriveEndpoint("https://codex-gateway.example", "openai-responses"),
    "https://codex-gateway.example/v1/responses",
  );
  assert.equal(
    deriveEndpoint("https://codex-gateway.example/v1", "openai-responses"),
    "https://codex-gateway.example/v1/responses",
  );
});

test("derives the endpoint used by the Codex Responses API", () => {
  assert.equal(
    deriveEndpoint("https://codex-gateway.example/backend-api", "openai-codex-responses"),
    "https://codex-gateway.example/backend-api/codex/responses",
  );
  assert.equal(
    deriveEndpoint("https://codex-gateway.example/backend-api/codex", "openai-codex-responses"),
    "https://codex-gateway.example/backend-api/codex/responses",
  );
  assert.equal(
    deriveEndpoint(
      "https://codex-gateway.example/backend-api/codex/responses",
      "openai-codex-responses",
    ),
    "https://codex-gateway.example/backend-api/codex/responses",
  );
});

test("allows an explicit same-origin endpoint override", () => {
  const supported = capableModel(model({ compat: configuredCompat }));
  assert.equal(
    supported?.capability.endpoint,
    "https://codex-gateway.example/v1/responses",
  );

  const unversioned = capableModel(
    model({
      baseUrl: "https://codex-gateway.example",
      api: "openai-responses",
      compat: {
        remoteCompaction: {
          protocol: "v2",
          endpoint: "https://codex-gateway.example/responses",
        },
      },
    }),
  );
  assert.equal(unversioned?.capability.endpoint, "https://codex-gateway.example/responses");
});

test("accepts capabilities inherited from providers or applied by modelOverrides", () => {
  const inherited = model({ compat: configuredCompat });
  const overridden = model({ compat: { ...configuredCompat, supportsToolSearch: true } });
  assert.ok(capableModel(inherited));
  assert.ok(capableModel(overridden));
});

test("rejects missing, malformed, cross-origin, and unsupported capabilities", () => {
  assert.equal(capableModel(model()), undefined);
  assert.equal(capableModel(model({ compat: { remoteCompaction: true } })), undefined);
  assert.equal(
    capableModel(
      model({ compat: { remoteCompaction: { protocol: "v2", endpoint: 42 } } }),
    ),
    undefined,
  );
  assert.equal(
    capableModel(
      model({
        compat: {
          remoteCompaction: {
            protocol: "v3",
            endpoint: "https://codex-gateway.example/v1/responses",
          },
        },
      }),
    ),
    undefined,
  );
  assert.equal(
    capableModel(
      model({
        compat: {
          remoteCompaction: {
            protocol: "v2",
            endpoint: "https://other.example/v1/responses",
          },
        },
      }),
    ),
    undefined,
  );
  assert.equal(capableModel(model({ api: "openai-completions", compat: configuredCompat })), undefined);
});

test("normalizes safe URLs and rejects ambiguous endpoint identities", () => {
  assert.equal(normalizeUrl("https://example.test/v1/"), "https://example.test/v1");
  assert.throws(() => normalizeUrl("https://user:pass@example.test/v1"), /credentials/);
  assert.throws(() => normalizeUrl("https://example.test/v1?route=a"), /query/);
});
