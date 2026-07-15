/**
 * Receivables — the "book that balances".
 *
 * A charge is money the operator is OWED:
 *   kind 'cycle'  — auto-generated each billing cycle from an active client's
 *                   amount + billing_period (the core upgrade: FieldText now
 *                   KNOWS who owes without being told)
 *   kind 'manual' — "bob owes 300"
 *   kind 'job'    — a priced one-off job marked done
 *
 * Payments settle open charges oldest-first (partials leave a balance).
 * "Who owes me?" and the dashboard Outstanding tile read from here.
 */
import { db } from "./supabase";
import { todayInTz } from "./normalize";
import type { Business, Charge, Client } from "./types";

/**
 * Next cycle date: weekly +7d, biweekly +14d, monthly +1 calendar month (day
 * clamped). For monthly pass anchorDay (day-of-month of the FIRST cycle charge)
 * so a client billed on the 31st snaps back to the 31st after a short month
 * instead of drifting to the 28th forever.
 */
export function nextCycleDate(ymd: string, period: string, anchorDay?: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (period === "weekly" || period === "biweekly") {
    const dt = new Date(Date.UTC(y, m - 1, d + (period === "weekly" ? 7 : 14)));
    return dt.toISOString().slice(0, 10);
  }
  // monthly: anchor day next month, clamped to the shorter month's end
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(y, m, Math.min(anchorDay ?? d, lastOfNext)));
  return dt.toISOString().slice(0, 10);
}

const RECURRING = new Set(["weekly", "biweekly", "monthly"]);

/**
 * Generate any cycle charges that have come due for a business's active clients.
 * Idempotent: checks (client_id, due_on, kind='cycle') before inserting (the DB
 * also has a partial unique index as a belt-and-suspenders guard).
 */
export async function generateDueCharges(business: Business, now: Date = new Date()): Promise<number> {
  const today = todayInTz(business.timezone, now);
  const { data: clientRows } = await db()
    .from("clients").select("*").eq("business_id", business.id).eq("status", "active");
  let created = 0;

  for (const c of (clientRows ?? []) as Client[]) {
    if (c.amount == null || !c.billing_period || !RECURRING.has(c.billing_period)) continue;

    const { data: lastRows } = await db()
      .from("charges").select("*")
      .eq("client_id", c.id).eq("kind", "cycle")
      .order("due_on", { ascending: false }).limit(1);
    const last = ((lastRows ?? []) as Charge[])[0];

    // Monthly anchor day comes from the FIRST cycle charge, so short months
    // clamp for one cycle and then snap back (no permanent 31st→28th drift).
    let anchorDay: number | undefined;
    if (c.billing_period === "monthly") {
      const { data: firstRows } = await db()
        .from("charges").select("*")
        .eq("client_id", c.id).eq("kind", "cycle")
        .order("due_on", { ascending: true }).limit(1);
      const first = ((firstRows ?? []) as Charge[])[0];
      if (first) anchorDay = Number(first.due_on.slice(8, 10));
    }

    // Anchor the next due date. A fresh client's first cycle lands one period
    // after they were ADDED (day one is not already owed — the anchor must be
    // their fixed created date, not "today", or it re-anchors every run and
    // never comes due). A client with history advances from their latest
    // charge; if MULTIPLE cycles have elapsed (paused-then-resumed, long
    // outage) we fast-forward to the most recent cycle date instead of
    // back-billing the whole gap.
    const startYmd = (c.created_at ?? "").slice(0, 10) || today;
    let due = last
      ? nextCycleDate(last.due_on, c.billing_period, anchorDay)
      : nextCycleDate(startYmd, c.billing_period);
    let next = nextCycleDate(due, c.billing_period, anchorDay);
    while (next <= today) {
      due = next;
      next = nextCycleDate(due, c.billing_period, anchorDay);
    }

    if (due <= today) {
      const { data: existing } = await db()
        .from("charges").select("id").eq("client_id", c.id).eq("kind", "cycle").eq("due_on", due).limit(1);
      if (!((existing ?? []) as unknown[]).length) {
        const { data: inserted } = await db().from("charges").insert({
          business_id: business.id,
          client_id: c.id,
          amount: c.amount,
          paid_amount: 0,
          status: "open",
          due_on: due,
          description: c.service_description ?? null,
          kind: "cycle",
        }).select("id").single();
        created++;
        // Money paid ahead of this cycle covers it automatically.
        if (inserted) await applyCreditToCharge(business.id, c.id, (inserted as { id: string }).id, Number(c.amount));
      }
    }
  }
  return created;
}

// ── Client credit ─────────────────────────────────────────────────────────────
// Money paid with nothing open to apply it to (paid early, or overpaid) is
// banked on the client and consumed automatically by the next charge. Without
// this, paying on the 1st before the cycle charge generates — the HAPPY path —
// double-counted as debt, and overpayments silently vanished.

/** The client's banked credit (unapplied payment money). */
export async function clientCredit(businessId: string, clientId: string): Promise<number> {
  const { data } = await db().from("clients").select("*").eq("id", clientId).eq("business_id", businessId).maybeSingle();
  return Number((data as { credit?: number } | null)?.credit) || 0;
}

async function setCredit(businessId: string, clientId: string, credit: number): Promise<void> {
  await db().from("clients").update({ credit: Math.max(0, Math.round(credit * 100) / 100) }).eq("id", clientId).eq("business_id", businessId);
}

/** Consume banked credit against a freshly created charge. */
async function applyCreditToCharge(businessId: string, clientId: string, chargeId: string, chargeAmount: number): Promise<void> {
  const credit = await clientCredit(businessId, clientId);
  if (credit <= 0.004) return;
  const use = Math.min(credit, chargeAmount);
  await db().from("charges")
    .update({ paid_amount: use, status: use >= chargeAmount ? "paid" : "partial" })
    .eq("id", chargeId);
  await setCredit(businessId, clientId, credit - use);
}

/** "bob owes 300" — an ad-hoc receivable. */
export async function createManualCharge(
  businessId: string, clientId: string | null, amount: number, dueOn: string, description?: string | null
): Promise<void> {
  const { data } = await db().from("charges").insert({
    business_id: businessId, client_id: clientId, amount, paid_amount: 0,
    status: "open", due_on: dueOn, description: description ?? null, kind: "manual",
  }).select("id").single();
  if (clientId && data) await applyCreditToCharge(businessId, clientId, (data as { id: string }).id, amount);
}

/** A priced one-off job marked done becomes money owed. */
export async function createJobCharge(
  businessId: string, clientId: string | null, amount: number, dueOn: string, description?: string | null, jobId?: string | null
): Promise<void> {
  const { data } = await db().from("charges").insert({
    business_id: businessId, client_id: clientId, amount, paid_amount: 0,
    status: "open", due_on: dueOn, description: description ?? null, kind: "job",
    job_id: jobId ?? null,
  }).select("id").single();
  if (clientId && data) await applyCreditToCharge(businessId, clientId, (data as { id: string }).id, amount);
}

/**
 * Remove the receivable a job created (call BEFORE deleting the job row).
 * Unpaid charge → deleted outright. Partially/fully paid → the charge shrinks
 * to what was actually paid, so applied payments stay consistent and nothing
 * further is owed. Fixes phantom debt from deleted jobs.
 */
export async function removeJobCharge(businessId: string, jobId: string): Promise<void> {
  const { data: rows } = await db()
    .from("charges").select("*").eq("business_id", businessId).eq("job_id", jobId);
  for (const ch of (rows ?? []) as Charge[]) {
    const paid = Number(ch.paid_amount) || 0;
    if (paid <= 0.004) {
      await db().from("charges").delete().eq("id", ch.id);
    } else {
      await db().from("charges").update({ amount: paid, status: "paid" }).eq("id", ch.id);
    }
  }
}

/** Settle a payment against a client's open charges, oldest first. Returns the remaining balance. */
export async function applyPaymentToCharges(businessId: string, clientId: string, amount: number): Promise<number> {
  const { data: rows } = await db()
    .from("charges").select("*")
    .eq("business_id", businessId).eq("client_id", clientId)
    .in("status", ["open", "partial"])
    .order("due_on", { ascending: true });
  let remaining = amount;
  for (const ch of (rows ?? []) as Charge[]) {
    if (remaining <= 0) break;
    const need = Number(ch.amount) - Number(ch.paid_amount);
    if (need <= 0) continue;
    const pay = Math.min(need, remaining);
    const paidAmount = Number(ch.paid_amount) + pay;
    await db().from("charges")
      .update({ paid_amount: paidAmount, status: paidAmount >= Number(ch.amount) ? "paid" : "partial" })
      .eq("id", ch.id);
    remaining -= pay;
  }
  // Leftover money (paid early / overpaid) is banked as credit, never dropped.
  if (remaining > 0.004) {
    const cur = await clientCredit(businessId, clientId);
    await setCredit(businessId, clientId, cur + remaining);
  }
  return clientBalance(businessId, clientId);
}

/**
 * Undo a deleted payment's effect on the ledger: give the amount back to the
 * client's settled charges, newest first (the mirror of applyPaymentToCharges).
 * Without this, deleting a fat-fingered "$4500" payment would leave the charges
 * marked paid and "who owes me?" would still say zero.
 */
export async function reversePaymentFromCharges(businessId: string, clientId: string, amount: number): Promise<void> {
  let remaining = amount;
  // Claw back banked credit first — the part of the payment that never touched
  // a charge. Otherwise deleting an overpayment would over-reverse the charges.
  const credit = await clientCredit(businessId, clientId);
  if (credit > 0.004) {
    const take = Math.min(credit, remaining);
    await setCredit(businessId, clientId, credit - take);
    remaining -= take;
  }
  if (remaining <= 0.004) return;
  const { data: rows } = await db()
    .from("charges").select("*")
    .eq("business_id", businessId).eq("client_id", clientId)
    .in("status", ["paid", "partial"])
    .order("due_on", { ascending: false });
  for (const ch of (rows ?? []) as Charge[]) {
    if (remaining <= 0) break;
    const paid = Number(ch.paid_amount);
    if (paid <= 0) continue;
    const take = Math.min(paid, remaining);
    const newPaid = paid - take;
    await db().from("charges")
      .update({ paid_amount: newPaid, status: newPaid <= 0 ? "open" : "partial" })
      .eq("id", ch.id);
    remaining -= take;
  }
}

/** What one client still owes. */
export async function clientBalance(businessId: string, clientId: string): Promise<number> {
  const { data: rows } = await db()
    .from("charges").select("*")
    .eq("business_id", businessId).eq("client_id", clientId)
    .in("status", ["open", "partial"]);
  return ((rows ?? []) as Charge[]).reduce((s, ch) => s + (Number(ch.amount) - Number(ch.paid_amount)), 0);
}

/** Every open balance for a business, biggest first. */
export async function openBalances(businessId: string): Promise<{ client_id: string | null; balance: number; oldest_due: string }[]> {
  const { data: rows } = await db()
    .from("charges").select("*")
    .eq("business_id", businessId)
    .in("status", ["open", "partial"])
    .order("due_on", { ascending: true });
  const byClient = new Map<string | null, { balance: number; oldest_due: string }>();
  for (const ch of (rows ?? []) as Charge[]) {
    const cur = byClient.get(ch.client_id) ?? { balance: 0, oldest_due: ch.due_on };
    cur.balance += Number(ch.amount) - Number(ch.paid_amount);
    if (ch.due_on < cur.oldest_due) cur.oldest_due = ch.due_on;
    byClient.set(ch.client_id, cur);
  }
  return [...byClient.entries()]
    .map(([client_id, v]) => ({ client_id, ...v }))
    .filter((x) => x.balance > 0.004)
    .sort((a, b) => b.balance - a.balance);
}

/** Total outstanding for a business. */
export async function totalOutstanding(businessId: string): Promise<number> {
  const balances = await openBalances(businessId);
  return balances.reduce((s, b) => s + b.balance, 0);
}
