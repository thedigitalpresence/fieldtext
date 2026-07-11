import { test } from "node:test";
import assert from "node:assert/strict";
import { safeTz, DEFAULT_TZ } from "../normalize";
import { formatWhen } from "../reminders";

test("safeTz: empty / invalid falls back to Pacific, valid passes through", () => {
  assert.equal(safeTz(""), DEFAULT_TZ);
  assert.equal(safeTz(null), DEFAULT_TZ);
  assert.equal(safeTz(undefined), DEFAULT_TZ);
  assert.equal(safeTz("Not/AZone"), DEFAULT_TZ);
  assert.equal(safeTz("America/New_York"), "America/New_York");
  assert.equal(safeTz("America/Los_Angeles"), "America/Los_Angeles");
});

test("formatWhen: a missing timezone shows local (Pacific) time, never UTC", () => {
  // 6:11 PM UTC = 11:11 AM Pacific (PDT). The bug showed 6:11 PM.
  const iso = "2026-07-11T18:11:00Z";
  const shown = formatWhen(iso, "");
  assert.match(shown, /11:11/, `expected Pacific 11:11, got "${shown}"`);
  assert.match(shown, /AM/, `expected AM, got "${shown}"`);
  assert.ok(!/6:11.?PM/i.test(shown), `must not show UTC 6:11 PM, got "${shown}"`);
});

test("formatWhen: an explicit timezone is respected", () => {
  const iso = "2026-07-11T18:11:00Z"; // 2:11 PM Eastern (EDT)
  assert.match(formatWhen(iso, "America/New_York"), /2:11/);
});
