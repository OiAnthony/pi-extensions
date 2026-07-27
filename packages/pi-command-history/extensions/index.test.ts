import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EditorComponent } from "@mariozechner/pi-tui";
import { getHistoryNavigationAction } from "./index.js";

type BoundaryEditor = EditorComponent & {
  isOnFirstVisualLine: () => boolean;
  isOnLastVisualLine: () => boolean;
  isShowingAutocomplete?: () => boolean;
  focused?: boolean;
};

function createEditor(first: boolean, last: boolean): BoundaryEditor {
  return {
    isOnFirstVisualLine: () => first,
    isOnLastVisualLine: () => last,
  } as BoundaryEditor;
}

function action(
  editor: BoundaryEditor | undefined,
  text: string,
  historyIndex: number,
  matchesPrev: boolean,
  matchesNext: boolean,
): ReturnType<typeof getHistoryNavigationAction> {
  return getHistoryNavigationAction(editor, text, historyIndex, 2, matchesPrev, matchesNext);
}

describe("getHistoryNavigationAction", () => {
  test("starts history browsing only from an empty editor", () => {
    const editor = createEditor(true, true);

    assert.equal(action(editor, "", -1, true, false), "previous");
    assert.equal(action(editor, "draft", -1, true, false), undefined);
    assert.equal(action(editor, "", -1, false, true), undefined);
  });

  test("continues browsing only at the matching visual boundary", () => {
    assert.equal(action(createEditor(true, false), "first\nsecond", 0, true, false), "previous");
    assert.equal(action(createEditor(true, false), "first\nsecond", 0, false, true), undefined);
    assert.equal(action(createEditor(false, true), "first\nsecond", 0, true, false), undefined);
    assert.equal(action(createEditor(false, true), "first\nsecond", 0, false, true), "next");
  });

  test("does not navigate history while autocomplete is active or the editor is unfocused", () => {
    const autocompleteEditor = createEditor(true, true);
    autocompleteEditor.isShowingAutocomplete = () => true;
    assert.equal(action(autocompleteEditor, "", -1, true, false), undefined);

    const unfocusedEditor = createEditor(true, true);
    unfocusedEditor.focused = false;
    assert.equal(action(unfocusedEditor, "", -1, true, false), undefined);
  });

  test("requires exactly one configured navigation direction", () => {
    const editor = createEditor(true, true);

    assert.equal(action(undefined, "", -1, true, false), undefined);
    assert.equal(action(editor, "", -1, false, false), undefined);
    assert.equal(action(editor, "", -1, true, true), undefined);
  });
});
