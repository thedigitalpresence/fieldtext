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

/** Next cycle date: weekly +7d, biweekly +14d, monthly +1 calendar month (day clamped). */
export function nextCycleDate(ymd: string, period: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (period === "weekly" || period === "biweekly") {
    const dt = new Date(Date.UTC(y, m - 1, d + (period === "weekly" ? 7 : 14)));
    return dt.toISOString().slice(0, 10);
  }
  // monthly: same day next month, clamped to the shorter month's end
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(y, m, Math.min(d, lastOfNext)));
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

    // Anchor: the day after the latest existing cycle charge, or today for a fresh client.
    const { data: lastRows } = await db()
      .from("charges").select("*")
      .eq("client_id", c.id).eq("kind", "cycle")
      .order("due_on", { ascending: false }).limit(1);
    const last = ((lastRows ?? []) as Charge[])[0];

    let due = last ? nextCycleDate(last.due_on, c.billing_period) : today;
    let guard = 0;
    while (due <= today && guard++ < 12) {
      const { data: existing } = await db()
        .from("charges").select("id").eq("client_id", c.id).eq("kind", "cycle").eq("due_on", due).limit(1);
      if (!((existing ?? []) as unknown[]).length) {
        await db().from("charges").insert({
          business_id: business.id,
          client_id: c.id,
          amount: c.amount,
          paid_amount: 0,
          status: "open",
          due_on: due,
          description: c.service_description ?? null,
          kind: "cycle",
        });
        created++;
      }
      due = nextCycleDate(due, c.billing_period);
    }
  }
  return created;
}

/** "bob owes 300" — an ad-hoc receivable. */
export async function createManualCharge(
  businessId: string, clientId: string | null, amount: number, dueOn: string, description?: string | null
): Promise<void> {
  await db().from("charges").insert({
    business_id: businessId, client_id: clientId, amount, paid_amount: 0,
    status: "open", due_on: dueOn, description: description ?? null, kind: "manual",
  });
}

/** A priced one-off job marked done becomes money owed. */
export async function createJobCharge(
  businessId: string, clientId: string | null, amount: number, dueOn: string, description?: string | null
): Promise<void> {
  await db().from("charges").insert({
    business_id: businessId, client_id: clientId, amount, paid_amount: 0,
    status: "open", due_on: dueOn, description: description ?? null, kind: "job",
  });
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
  return clientBalance(businessId, clientId);
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
