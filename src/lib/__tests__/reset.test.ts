/**
 * SMS password reset: code goes to a registered number, verifies once, sets a
 * new hashed password, and can't be reused or brute-forced.
 */
process.env.LOCAL_TEST = "true";
process.env.SMS_DRY_RUN = "true";
process.env.DASHBOARD_PASSWORD = "master";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DB_FILE } from "../testdb";
import { db } from "../supabase";
import { requestReset, completeReset } from "../reset";
import { verifyPassword } from "../password";

async function seedOperator(phone: string) {
  fs.rmSync(TEST_DB_FILE, { force: true });
  const { data } = await db().from("businesses").select("*"); // seed
  const bid = (data as { id: string }[])[0].id;
  await db().from("authorized_phones").insert({ business_id: bid, phone, is_primary: true, opted_out: false, created_at: new Date().toISOString() });
  return bid;
}
// The code is hashed in storage, so happy-path tests insert a known code hash
// (exactly what requestReset would store) rather than trying to read it back.

test("unknown number stays silent (no reset row, no throw)", async () => {
  await seedOperator("+15551110000");
  await requestReset("+19998887777");
  const { data } = await db().from("password_resets").select("*");
  assert.equal((data as unknown[]).length, 0);
});

test("wrong code is rejected and counts against attempts", async () => {
  await seedOperator("+15551110001");
  await requestReset("+15551110001");
  const r1 = await completeReset("+15551110001", "000000", "newpass1");
  assert.equal(r1.ok, false);
  assert.match(r1.error ?? "", /incorrect/i);
  const { data } = await db().from("password_resets").select("*").eq("phone", "+15551110001");
  assert.equal((data as { attempts: number }[])[0].attempts, 1, "attempt counted");
});

test("correct code sets a new hashed password and can't be reused", async () => {
  const bid = await seedOperator("+15551110002");
  // Capture the code by stubbing sendSms via the dry-run log is awkward; instead we
  // drive requestReset then read the stored row and set a known code hash ourselves,
  // simulating exactly what requestReset stored.
  const { hashPassword } = await import("../password");
  await db().from("password_resets").insert({
    phone: "+15551110002", business_id: bid, code_hash: hashPassword("123456"),
    expires_at: new Date(Date.now() + 15 * 60000).toISOString(), attempts: 0, used: false, created_at: new Date().toISOString(),
  });

  const ok = await completeReset("+15551110002", "123456", "brandNewPass");
  assert.equal(ok.ok, true);
  const { data: biz } = await db().from("businesses").select("*").eq("id", bid).single();
  assert.ok(verifyPassword("brandNewPass", (biz as { dashboard_password: string }).dashboard_password), "new password set (hashed)");

  // Reuse is blocked.
  const again = await completeReset("+15551110002", "123456", "another");
  assert.equal(again.ok, false, "code is single-use");
});

test("expired code is rejected", async () => {
  const bid = await seedOperator("+15551110003");
  const { hashPassword } = await import("../password");
  await db().from("password_resets").insert({
    phone: "+15551110003", business_id: bid, code_hash: hashPassword("654321"),
    expires_at: new Date(Date.now() - 1000).toISOString(), attempts: 0, used: false, created_at: new Date().toISOString(),
  });
  const res = await completeReset("+15551110003", "654321", "whatever1");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /expired/i);
});
