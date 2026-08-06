import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
} from "@earendil-works/pi-ai";
import { mergeRemoteCompactionHeader, requestRemoteCompaction } from "./remote.js";

const model = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  api: "openai-codex-responses",
  provider: "custom-codex",
  baseUrl: "https://codex-gateway.example/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<"openai-codex-responses">;
const endpoint = "https://codex-gateway.example/v1/responses";
const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function responseSse(content = "opaque") {
  const item = { type: "compaction", encrypted_content: content };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const fetchSse = (async () => responseSse()) as unknown as typeof globalThis.fetch;

function fakeProvider(
  observe: (
    payload: unknown,
    options: OpenAICodexResponsesOptions,
    requestModel: Model<"openai-codex-responses" | "openai-responses">,
  ) => void,
  inputText = "current",
  requestEndpoint = endpoint,
  requestOverrides: {
    method?: string;
    omitFeatureHeader?: boolean;
    payloadModel?: string;
  } = {},
): Provider {
  return {
    id: "custom-codex",
    name: "Custom Codex",
    baseUrl: model.baseUrl,
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(_model, _context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const payload = await options?.onPayload?.(
            {
              model: requestOverrides.payloadModel ?? model.id,
              input: [{ role: "user", content: [{ type: "input_text", text: inputText }] }],
            },
            model,
          );
          observe(
            payload,
            options as OpenAICodexResponsesOptions,
            _model as Model<"openai-codex-responses" | "openai-responses">,
          );
          const response = await options?.fetch?.(requestEndpoint, {
            method: requestOverrides.method ?? "POST",
            headers: requestOverrides.omitFeatureHeader ? {} : options.headers as HeadersInit,
          });
          await response?.text();
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "error" as const,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    streamSimple() {
      throw new Error("not used");
    },
  };
}

test("merges the V2 beta feature without dropping existing features", () => {
  assert.deepEqual(
    mergeRemoteCompactionHeader({ "X-Codex-Beta-Features": "feature_a,remote_compaction_v2" }),
    { "x-codex-beta-features": "feature_a,remote_compaction_v2" },
  );
});

test("uses a custom provider endpoint and validates request parameters", async () => {
  let sent: unknown;
  const provider = fakeProvider((payload, options) => {
    sent = payload;
    assert.equal(options.transport, "sse");
    assert.equal(options.cacheRetention, "none");
    assert.equal(options.timeoutMs, 300_000);
    assert.equal(options.maxRetries, 2);
    assert.match(options.headers?.["x-codex-beta-features"] ?? "", /remote_compaction_v2/);
  });
  const result = await requestRemoteCompaction({
    provider,
    model,
    context: { messages: [] } satisfies Context,
    endpoint,
    apiKey: "gateway-key",
    headers: { "x-codex-beta-features": "existing" },
    signal: new AbortController().signal,
    fetch: fetchSse,
  });
  assert.deepEqual((sent as { input: unknown[] }).input.at(-1), { type: "compaction_trigger" });
  assert.equal(result.item.encrypted_content, "opaque");
  assert.deepEqual(result.usage, usage);
});

test("uses the final endpoint as the OpenAI Responses transport base URL", async () => {
  const responsesModel = {
    ...model,
    api: "openai-responses" as const,
    baseUrl: "https://codex-gateway.example",
  } as Model<"openai-responses">;

  for (const [requestEndpoint, expectedBaseUrl] of [
    ["https://codex-gateway.example/v1/responses", "https://codex-gateway.example/v1"],
    ["https://codex-gateway.example/responses", "https://codex-gateway.example"],
  ] as const) {
    let providerBaseUrl: string | undefined;
    const provider = fakeProvider(
      (_payload, _options, requestModel) => {
        providerBaseUrl = requestModel.baseUrl;
      },
      "current",
      requestEndpoint,
    );
    await requestRemoteCompaction({
      provider,
      model: responsesModel,
      context: { messages: [] },
      endpoint: requestEndpoint,
      apiKey: "key",
      signal: new AbortController().signal,
      fetch: fetchSse,
    });
    assert.equal(providerBaseUrl, expectedBaseUrl);
  }
});

test("expands the previous checkpoint for repeated compaction", async () => {
  let sentInput: unknown[] = [];
  const provider = fakeProvider((payload) => {
    sentInput = (payload as { input: unknown[] }).input;
  }, "checkpoint marker");
  await requestRemoteCompaction({
    provider,
    model,
    context: { messages: [] },
    endpoint,
    apiKey: "key",
    signal: new AbortController().signal,
    priorCheckpoint: {
      marker: "checkpoint marker",
      replacementHistory: [{ type: "compaction", encrypted_content: "prior" }],
    },
    fetch: (async () => responseSse("new")) as unknown as typeof globalThis.fetch,
  });
  assert.equal((sentInput[0] as { encrypted_content?: string }).encrypted_content, "prior");
  assert.deepEqual(sentInput.at(-1), { type: "compaction_trigger" });
});

test("rejects endpoint substitution and falls through as an error", async () => {
  const provider = fakeProvider(() => undefined, "current", "https://attacker.example/responses");
  await assert.rejects(
    requestRemoteCompaction({
      provider,
      model,
      context: { messages: [] },
      endpoint,
      apiKey: "key",
      signal: new AbortController().signal,
      fetch: fetchSse,
    }),
    /unexpected compaction endpoint/,
  );
});

test("rejects method, feature header, and model identity substitutions", async () => {
  for (const [requestOverrides, expectedError] of [
    [{ method: "GET" }, /must use POST/],
    [{ omitFeatureHeader: true }, /omitted the Remote Compaction V2 feature header/],
    [{ payloadModel: "other-model" }, /unexpected model/],
  ] as const) {
    const provider = fakeProvider(() => undefined, "current", endpoint, requestOverrides);
    await assert.rejects(
      requestRemoteCompaction({
        provider,
        model,
        context: { messages: [] },
        endpoint,
        apiKey: "key",
        signal: new AbortController().signal,
        fetch: fetchSse,
      }),
      expectedError,
    );
  }
});
