/**
 * Billing-cycle charges: the anchor rules that keep "Money owed" trustworthy.
 *   • a fresh client's first cycle lands one period AFTER they were added
 *   • long gaps (pause/resume, outage) fast-forward — never back-bill the gap
 *   • a monthly client billed on the 31st clamps for short months then SNAPS BACK
 */
process.env.LOCAL_TEST = "true";
process.env.SMS_DRY_RUN = "true";
process.env.LLM_DRY_RUN = "true";
process.env.DASHBOARD_PASSWORD = "master";
process.env.OWNER_PHONE = "+15550001111";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DB_FILE } from "../testdb";
import { db } from "../supabase";
import { nextCycleDate, generateDueCharges, clientBalance } from "../charges";
import type { Business, Charge } from "../types";

async function fresh(): Promise<Business> {
  fs.rmSync(TEST_DB_FILE, { force: true });
  const { data } = await db().from("businesses").select("*");
  return (data as Business[])[0];
}

async function addClient(businessId: string, createdYmd: string, period = "weekly", amount = 100) {
  const { data } = await db().from("clients").insert({
    business_id: businessId, name: "Cycle Test", status: "active",
    amount, billing_period: period, created_at: `${createdYmd}T12:00:00.000Z`,
    updated_at: `${createdYmd}T12:00:00.000Z`,
  }).select("*").single();
  return data as { id: string };
}

async function cycleCharges(clientId: string): Promise<Charge[]> {
  const { data } = await db().from("charges").select("*").eq("client_id", clientId).eq("kind", "cycle");
  return ((data ?? []) as Charge[]).sort((a, b) => a.due_on.localeCompare(b.due_on));
}

// Noon UTC = same calendar day in America/New_York (the seeded business tz).
const at = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`);

test("nextCycleDate: weekly/biweekly/monthly, with monthly anchor snap-back", () => {
  assert.equal(nextCycleDate("2026-07-01", "weekly"), "2026-07-08");
  assert.equal(nextCycleDate("2026-07-01", "biweekly"), "2026-07-15");
  assert.equal(nextCycleDate("2026-01-31", "monthly"), "2026-02-28", "clamps into February");
  // Without the anchor the 28th sticks forever; WITH it the 31st comes back.
  assert.equal(nextCycleDate("2026-02-28", "monthly"), "2026-03-28", "unanchored drifts");
  assert.equal(nextCycleDate("2026-02-28", "monthly", 31), "2026-03-31", "anchored snaps back");
});

test("fresh client is NOT owed on day one — first cycle lands one period out", async () => {
  const biz = await fresh();
  const c = await addClient(biz.id, "2026-07-01");
  // Cron on the day they were added: nothing due yet.
  await generateDueCharges(biz, at("2026-07-01"));
  assert.equal((await cycleCharges(c.id)).length, 0, "no charge the day they're added");
  // Cron runs daily; the first charge appears exactly one period after creation.
  await generateDueCharges(biz, at("2026-07-07"));
  assert.equal((await cycleCharges(c.id)).length, 0, "still nothing at day 6");
  await generateDueCharges(biz, at("2026-07-08"));
  const charges = await cycleCharges(c.id);
  assert.equal(charges.length, 1, "one charge one week after creation");
  assert.equal(charges[0].due_on, "2026-07-08");
  assert.equal(await clientBalance(biz.id, c.id), 100);
});

test("steady weekly client accrues one charge per cycle under a daily cron", async () => {
  const biz = await fresh();
  const c = await addClient(biz.id, "2026-06-01");
  for (let d = 1; d <= 29; d++) {
    await generateDueCharges(biz, at(`2026-06-${String(d).padStart(2, "0")}`));
  }
  const dues = (await cycleCharges(c.id)).map((ch) => ch.due_on);
  assert.deepEqual(dues, ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"], "four weekly cycles, no gaps, no dupes");
});

test("a long gap fast-forwards instead of back-billing (pause/resume trust)", async () => {
  const biz = await fresh();
  const c = await addClient(biz.id, "2026-04-01");
  // One normal cycle billed in April…
  await generateDueCharges(biz, at("2026-04-08"));
  assert.equal((await cycleCharges(c.id)).length, 1);
  // …then a 10-week silence (paused, or cron down). Next run must NOT dump ~10 charges.
  await generateDueCharges(biz, at("2026-06-17"));
  const charges = await cycleCharges(c.id);
  assert.equal(charges.length, 2, "exactly one catch-up charge, not the whole gap");
  assert.equal(charges[1].due_on, "2026-06-17", "anchored to the most recent cycle date");
});

test("monthly client on the 31st: February clamps, March snaps back to the 31st", async () => {
  const biz = await fresh();
  const c = await addClient(biz.id, "2025-12-31", "monthly", 400);
  await generateDueCharges(biz, at("2026-01-31"));
  await generateDueCharges(biz, at("2026-02-28"));
  await generateDueCharges(biz, at("2026-03-31"));
  const dues = (await cycleCharges(c.id)).map((ch) => ch.due_on);
  assert.deepEqual(dues, ["2026-01-31", "2026-02-28", "2026-03-31"], "no permanent drift to the 28th");
});

test("FTXT-1: deleting a job removes its receivable (unpaid) or clamps it (partly paid)", async () => {
  const biz = await fresh();
  const c = await addClient(biz.id, "2026-07-01", "monthly", 200);
  const { createJobCharge, removeJobCharge, applyPaymentToCharges } = await import("../charges");

  // Unpaid job charge -> deleted outright.
  const { data: j1 } = await db().from("jobs").insert({ business_id: biz.id, client_id: c.id, description: "mulch", performed_on: "2026-07-10", status: "done", amount: 450 }).select("id").single();
  await createJobCharge(biz.id, c.id, 450, "2026-07-10", "mulch", (j1 as { id: string }).id);
  assert.equal(await clientBalance(biz.id, c.id), 450);
  await removeJobCharge(biz.id, (j1 as { id: string }).id);
  assert.equal(await clientBalance(biz.id, c.id), 0, "phantom debt removed");

  // Partly-paid job charge -> shrinks to what was paid; nothing further owed.
  const { data: j2 } = await db().from("jobs").insert({ business_id: biz.id, client_id: c.id, description: "fence", performed_on: "2026-07-11", status: "done", amount: 300 }).select("id").single();
  await createJobCharge(biz.id, c.id, 300, "2026-07-11", "fence", (j2 as { id: string }).id);
  await applyPaymentToCharges(biz.id, c.id, 100); // partial payment
  await removeJobCharge(biz.id, (j2 as { id: string }).id);
  assert.equal(await clientBalance(biz.id, c.id), 0, "no further owed after delete");
});
