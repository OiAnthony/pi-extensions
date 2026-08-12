import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import register, {
  ROLE_WIDGET_DURATION_MS,
  ROLE_WIDGET_GAP_LINES,
  ROLE_WIDGET_ID,
  ROLE_WIDGET_PADDING_X,
  nextRoleIndex,
  normalizeModelRoles,
  resolveRoleCandidates,
  type RoleExtensionDependencies,
  type ThinkingLevel,
} from "./index.js";

interface Model {
  provider: string;
  id: string;
}

type ShortcutHandler = (context: any) => Promise<void> | void;

const small: Model = { provider: "test", id: "small" };
const normal: Model = { provider: "test", id: "normal" };
const review: Model = { provider: "test", id: "review" };
const outside: Model = { provider: "test", id: "outside" };

function createHarness(options: {
  roles?: Record<string, string>;
  cycleOrder?: string[];
  initialModel?: Model;
  initialThinking?: ThinkingLevel;
  unavailable?: Set<string>;
  setModelResult?: boolean;
  clampThinking?: (level: ThinkingLevel) => ThinkingLevel;
} = {}) {
  const roles = options.roles ?? {
    small: "test/small:off",
    default: "test/normal:medium",
    review: "test/review:xhigh",
  };
  const config = normalizeModelRoles({ roles, ...(options.cycleOrder ? { cycleOrder: options.cycleOrder } : {}) });
  const models = [small, normal, review, outside];
  const handlers = new Map<string, ShortcutHandler>();
  const eventHandlers = new Map<string, (event: unknown, context: any) => void>();
  const notifications: Array<{ message: string; level: string }> = [];
  const widgets: Array<{ id: string; value: "component" | undefined; placement?: string }> = [];
  const calls: string[] = [];
  const timers = new Map<object, () => void>();
  let widgetComponent: { render(width: number): string[] } | undefined;
  let renderRequests = 0;
  let thinking = options.initialThinking ?? "off";
  const context: any = {
    model: options.initialModel ?? small,
    thinkingLevel: thinking,
    modelRegistry: {
      find: (provider: string, modelId: string) => models.find((model) => model.provider === provider && model.id === modelId),
      getApiKeyAndHeaders: async (model: Model) => options.unavailable?.has(model.id)
        ? { ok: false }
        : { ok: true, apiKey: `${model.id}-key` },
    },
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => `**${text}**`,
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setWidget: (id: string, value: unknown, widgetOptions?: { placement?: string }) => {
        widgets.push({
          id,
          value: value === undefined ? undefined : "component",
          ...(widgetOptions?.placement ? { placement: widgetOptions.placement } : {}),
        });
        if (typeof value === "function") {
          widgetComponent = value(
            { requestRender: () => { renderRequests++; } },
            context.ui.theme,
          ) as { render(width: number): string[] };
        } else if (value === undefined) {
          widgetComponent = undefined;
        }
      },
    },
  };
  const dependencies: RoleExtensionDependencies = {
    setTimer: (callback, delayMs) => {
      assert.equal(delayMs, ROLE_WIDGET_DURATION_MS);
      const timer = { unref() {} };
      timers.set(timer, callback);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => timers.delete(timer as unknown as object),
  };
  const pi = {
    registerShortcut: (shortcut: string, definition: { handler: ShortcutHandler }) => handlers.set(shortcut, definition.handler),
    on: (event: string, handler: (event: unknown, context: any) => void) => eventHandlers.set(event, handler),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: ThinkingLevel) => {
      calls.push(`thinking:${level}`);
      thinking = options.clampThinking?.(level) ?? level;
      context.thinkingLevel = thinking;
    },
    setModel: async (model: Model) => {
      calls.push(`model:${model.id}`);
      if (options.setModelResult === false) return false;
      context.model = model;
      return true;
    },
  } as unknown as ExtensionAPI;
  register(pi, config, dependencies);
  return {
    handlers,
    eventHandlers,
    context,
    notifications,
    widgets,
    calls,
    timers,
    getThinking: () => thinking,
    getRenderRequests: () => renderRequests,
    renderWidget: (width = 200) => widgetComponent?.render(width) ?? [],
    runTimer: () => {
      const callback = [...timers.values()][0];
      callback?.();
      timers.clear();
    },
  };
}

describe("role cycle helpers", () => {
  test("wraps in both directions and starts at directional boundaries", () => {
    assert.equal(nextRoleIndex(1, 3, 1), 2);
    assert.equal(nextRoleIndex(2, 3, 1), 0);
    assert.equal(nextRoleIndex(1, 3, -1), 0);
    assert.equal(nextRoleIndex(0, 3, -1), 2);
    assert.equal(nextRoleIndex(-1, 3, 1), 0);
    assert.equal(nextRoleIndex(-1, 3, -1), 2);
    assert.equal(nextRoleIndex(-1, 0, 1), -1);
  });

  test("skips unknown, missing, and unauthenticated roles", async () => {
    const config = normalizeModelRoles({
      roles: {
        valid: "test/small",
        missing: "test/missing",
        denied: "test/review",
        broken: "@unknown",
      },
    });
    const candidates = await resolveRoleCandidates(config, small, {
      find: (provider, id) => [small, review].find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async (model) => model === review ? { ok: false } : { ok: true },
    });
    assert.deepEqual(candidates.map((candidate) => candidate.name), ["valid"]);
  });
});

describe("model role extension", () => {
  test("registers forward and backward shortcuts and cycles from current state", async () => {
    const harness = createHarness({ initialModel: normal, initialThinking: "medium" });
    assert.deepEqual([...harness.handlers.keys()], ["ctrl+p", "ctrl+shift+p"]);

    await harness.handlers.get("ctrl+p")?.(harness.context);
    assert.equal(harness.context.model, review);
    assert.equal(harness.getThinking(), "xhigh");

    await harness.handlers.get("ctrl+shift+p")?.(harness.context);
    assert.equal(harness.context.model, normal);
    assert.equal(harness.getThinking(), "medium");
  });

  test("wraps and starts from boundaries when current state has no match", async () => {
    const wrapped = createHarness({ initialModel: review, initialThinking: "xhigh" });
    await wrapped.handlers.get("ctrl+p")?.(wrapped.context);
    assert.equal(wrapped.context.model, small);

    const forward = createHarness({ initialModel: outside });
    await forward.handlers.get("ctrl+p")?.(forward.context);
    assert.equal(forward.context.model, small);

    const backward = createHarness({ initialModel: outside });
    await backward.handlers.get("ctrl+shift+p")?.(backward.context);
    assert.equal(backward.context.model, review);
  });

  test("uses arbitrary names and explicit cycleOrder", async () => {
    const harness = createHarness({
      roles: { Review: "test/review", tiny: "test/small", ignored: "test/normal" },
      cycleOrder: ["Review", "tiny"],
      initialModel: review,
      initialThinking: "max",
    });
    await harness.handlers.get("ctrl+p")?.(harness.context);
    assert.equal(harness.context.model, small);
    assert.match(harness.renderWidget()[0] ?? "", /Review/);
    assert.doesNotMatch(harness.renderWidget()[0] ?? "", /ignored/);
  });

  test("handles zero and one available candidate", async () => {
    const empty = createHarness({ roles: { missing: "test/missing" } });
    await empty.handlers.get("ctrl+p")?.(empty.context);
    assert.equal(empty.context.model, small);
    assert.equal(empty.notifications.at(-1)?.level, "error");

    const single = createHarness({ roles: { only: "test/normal" }, initialModel: normal });
    await single.handlers.get("ctrl+p")?.(single.context);
    assert.equal(single.context.model, normal);
    assert.deepEqual(single.calls, ["model:normal"]);
    assert.match(single.renderWidget()[0] ?? "", /\*\*\[only\]\*\*/);
  });

  test("sets the model before thinking and displays the clamped final level", async () => {
    const harness = createHarness({
      initialModel: small,
      initialThinking: "off",
      clampThinking: (level) => level === "medium" ? "low" : level,
    });
    await harness.handlers.get("ctrl+p")?.(harness.context);
    assert.deepEqual(harness.calls, ["model:normal", "thinking:medium"]);
    assert.equal(harness.getThinking(), "low");
    assert.match(harness.renderWidget()[0] ?? "", /\(low\)$/);
  });

  test("does not set thinking for a role without a suffix", async () => {
    const harness = createHarness({ roles: { plain: "test/normal" }, initialThinking: "high" });
    await harness.handlers.get("ctrl+p")?.(harness.context);
    assert.deepEqual(harness.calls, ["model:normal"]);
    assert.equal(harness.getThinking(), "high");
  });

  test("preserves state and omits the widget when setModel fails", async () => {
    const harness = createHarness({ initialModel: small, initialThinking: "off", setModelResult: false });
    await harness.handlers.get("ctrl+p")?.(harness.context);
    assert.equal(harness.context.model, small);
    assert.equal(harness.getThinking(), "off");
    assert.deepEqual(harness.calls, ["model:normal"]);
    assert.equal(harness.widgets.length, 0);
    assert.equal(harness.notifications.at(-1)?.level, "error");
  });

  test("pre-registers one stable widget above the editor and clears it in place", async () => {
    const harness = createHarness({ initialModel: small });
    harness.eventHandlers.get("session_start")?.({}, harness.context);
    assert.deepEqual(harness.widgets, [{
      id: ROLE_WIDGET_ID,
      value: "component",
      placement: "aboveEditor",
    }]);
    assert.deepEqual(harness.renderWidget(), []);

    await harness.handlers.get("ctrl+p")?.(harness.context);
    const firstTimer = [...harness.timers.keys()][0];
    const firstRenderRequests = harness.getRenderRequests();
    const renderedLines = harness.renderWidget();
    const rendered = renderedLines[0] ?? "";
    assert.equal(renderedLines.length, 1 + ROLE_WIDGET_GAP_LINES);
    assert.deepEqual(renderedLines.slice(1), Array.from({ length: ROLE_WIDGET_GAP_LINES }, () => ""));
    assert.ok(rendered.startsWith(" ".repeat(ROLE_WIDGET_PADDING_X)));
    assert.equal(rendered.startsWith(" ".repeat(ROLE_WIDGET_PADDING_X + 1)), false);
    assert.match(rendered, /\*\*\[default\]\*\*/);
    const narrowLines = harness.renderWidget(12);
    assert.ok(visibleWidth(narrowLines[0] ?? "") <= 12);
    assert.deepEqual(narrowLines.slice(1), Array.from({ length: ROLE_WIDGET_GAP_LINES }, () => ""));

    await harness.handlers.get("ctrl+p")?.(harness.context);
    assert.equal(harness.timers.has(firstTimer), false);
    assert.equal(harness.timers.size, 1);
    assert.equal(harness.widgets.length, 1);
    assert.ok(harness.getRenderRequests() > firstRenderRequests);

    harness.runTimer();
    assert.deepEqual(harness.renderWidget(), []);
    assert.equal(harness.widgets.length, 1);
  });

  test("clears the role widget during session shutdown", async () => {
    const harness = createHarness();
    await harness.handlers.get("ctrl+p")?.(harness.context);
    harness.eventHandlers.get("session_shutdown")?.({}, harness.context);
    assert.deepEqual(harness.widgets.at(-1), { id: ROLE_WIDGET_ID, value: undefined });
    assert.equal(harness.timers.size, 0);
  });
});
