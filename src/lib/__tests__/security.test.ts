/**
 * Password hashing + login throttling.
 */
process.env.LOCAL_TEST = "true";
process.env.DASHBOARD_PASSWORD = "master";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hashPassword, verifyPassword, isHashed, safeEqual } from "../password";
import { throttleStatus, recordFailure, clearFailures } from "../security";
import { TEST_DB_FILE } from "../testdb";
import { db } from "../supabase";

test("hash is not the plaintext and verifies", () => {
  const h = hashPassword("hunter2");
  assert.ok(isHashed(h), "stored as scrypt$…");
  assert.ok(!h.includes("hunter2"), "plaintext not present");
  assert.equal(verifyPassword("hunter2", h), true);
  assert.equal(verifyPassword("wrong", h), false);
});

test("two hashes of the same password differ (salted)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("verify tolerates legacy plaintext but we never write it", () => {
  assert.equal(verifyPassword("plain", "plain"), true); // legacy fallback
  assert.equal(verifyPassword("plain", "other"), false);
});

test("safeEqual is correct", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("throttle locks after 5 failures, clears on success", async () => {
  fs.rmSync(TEST_DB_FILE, { force: true });
  await db().from("businesses").select("*"); // seed
  const id = "+15551234567";
  for (let i = 0; i < 4; i++) await recordFailure(id);
  assert.equal(await throttleStatus(id), 0, "not locked at 4 fails");
  await recordFailure(id); // 5th
  const mins = await throttleStatus(id);
  assert.ok(mins > 0 && mins <= 15, `locked ~15 min, got ${mins}`);
  await clearFailures(id);
  assert.equal(await throttleStatus(id), 0, "cleared after success");
});
