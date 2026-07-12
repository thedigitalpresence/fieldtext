import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../templates";
import { scrubReminderTime } from "../normalize";

test("scrubReminderTime: time words are the WHEN, not the task", () => {
  assert.equal(scrubReminderTime("send later today"), "send");
  assert.equal(scrubReminderTime("send later"), "send");
  assert.equal(scrubReminderTime("call bob tomorrow morning"), "call bob");
  assert.equal(scrubReminderTime("follow up next week"), "follow up");
  assert.equal(scrubReminderTime("tomorrow call the dump"), "call the dump");
  assert.equal(scrubReminderTime("invoice the smiths at 2:30pm"), "invoice the smiths");
  // Mid-task time words are content, not schedule — left alone.
  assert.equal(scrubReminderTime("reschedule tuesday's visit with bob"), "reschedule tuesday's visit with bob");
  // Numbers that aren't clock times survive.
  assert.equal(scrubReminderTime("call unit 12"), "call unit 12");
  // Never scrubs to nothing.
  assert.equal(scrubReminderTime("tomorrow"), "tomorrow");
});

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
