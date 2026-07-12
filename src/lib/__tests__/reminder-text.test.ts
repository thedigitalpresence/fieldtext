import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../templates";

test("taggedReminder: thin task gets the client's name; already-named text is untouched", () => {
  // "new reminder for elena send later today" -> text "send" + linked Elena
  assert.equal(t.taggedReminder("send", "Elena Shackelford"), "send · Elena Shackelford");
  assert.equal(t.taggedReminder("send the invoice", "Elena Shackelford"), "send the invoice · Elena Shackelford");
  // Name already present (any case) -> no duplicate tag
  assert.equal(t.taggedReminder("quote mitch k", "Mitch K"), "quote mitch k");
  assert.equal(t.taggedReminder("call Elena back", "Elena Shackelford"), "call Elena back");
  // No client linked -> unchanged
  assert.equal(t.taggedReminder("grab mulch", null), "grab mulch");
});
