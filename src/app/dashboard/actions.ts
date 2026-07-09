"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { config } from "@/lib/config";
import { AUTH_COOKIE } from "@/middleware";
import { db, getBusiness } from "@/lib/supabase";
import { createReminder, cancelQuoteReminders } from "@/lib/reminders";
import { normalizeAmount, normalizeName, normalizeAddress } from "@/lib/normalize";
import type { ChargeStatus, ClientStatus, Lang } from "@/lib/types";

export async function login(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");
  if (password && password === config.dashboardPassword()) {
    cookies().set(AUTH_COOKIE, password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    redirect(next.startsWith("/dashboard") ? next : "/dashboard");
  }
  redirect(`/dashboard/login?error=1&next=${encodeURIComponent(next)}`);
}

export async function logout() {
  cookies().delete(AUTH_COOKIE);
  redirect("/dashboard/login");
}

// ── Dashboard mutations (tap equivalents of the text actions) ─────────────────

export async function setLanguage(formData: FormData) {
  const lang = (String(formData.get("lang")) === "es" ? "es" : "en") as Lang;
  const b = await getBusiness();
  await db().from("businesses").update({ settings: { ...(b.settings ?? {}), language: lang } }).eq("id", b.id);
  revalidatePath("/dashboard");
}

export async function markStatus(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const status = String(formData.get("status")) as ClientStatus;
  const b = await getBusiness();
  await db().from("clients").update({ status, updated_at: new Date().toISOString() }).eq("id", clientId).eq("business_id", b.id);
  if (status !== "quoted") await cancelQuoteReminders(clientId);
  revalidatePath("/dashboard");
}

export async function addNote(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return;
  const b = await getBusiness();
  const { data } = await db().from("clients").select("notes").eq("id", clientId).single();
  const existing = (data as { notes: string | null } | null)?.notes ?? "";
  const merged = existing ? `${existing}\n${note}` : note;
  await db().from("clients").update({ notes: merged, updated_at: new Date().toISOString() }).eq("id", clientId).eq("business_id", b.id);
  revalidatePath("/dashboard");
}

export async function addReminderAction(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;
  const b = await getBusiness();
  const due = new Date();
  due.setDate(due.getDate() + 3);
  due.setHours(9, 0, 0, 0);
  await createReminder({ businessId: b.id, clientId, text, dueISO: due.toISOString(), kind: "manual" });
  revalidatePath("/dashboard");
}

export async function logPayment(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const amount = normalizeAmount(String(formData.get("amount") ?? ""));
  if (amount == null) return;
  const b = await getBusiness();
  await db().from("payments").insert({ business_id: b.id, client_id: clientId, amount, paid_on: new Date().toISOString().slice(0, 10) });
  revalidatePath("/dashboard");
}

/** Edit a client's core fields from the dashboard. Empty text field = cleared. */
export async function editClient(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const b = await getBusiness();
  const val = (k: string) => { const v = formData.get(k); return v == null ? "" : String(v).trim(); };
  const amtRaw = val("amount");
  const patch: Record<string, unknown> = {
    name: normalizeName(val("name")) ?? undefined,
    address: val("address") ? normalizeAddress(val("address")) : null,
    phone: val("phone") || null,
    service_description: val("service") || null,
    amount: amtRaw ? normalizeAmount(amtRaw) ?? null : null,
    billing_period: val("billing_period") || null,
    updated_at: new Date().toISOString(),
  };
  if (!patch.name) delete patch.name; // never blank the name
  await db().from("clients").update(patch).eq("id", clientId).eq("business_id", b.id);
  revalidatePath("/dashboard");
}

/** Every open charge for a client (or the "unassigned" bucket). */
async function openChargesFor(businessId: string, clientKey: string) {
  const { data } = await db().from("charges").select("*").eq("business_id", businessId).in("status", ["open", "partial"]);
  return ((data ?? []) as { id: string; client_id: string | null; amount: number; paid_amount: number; status: ChargeStatus }[])
    .filter((c) => (c.client_id ?? "unassigned") === clientKey);
}

/** "They paid" — record the payment for the balance and mark the charges settled. */
export async function settleBalance(formData: FormData) {
  const clientKey = String(formData.get("clientId"));
  const b = await getBusiness();
  const rows = await openChargesFor(b.id, clientKey);
  const balance = rows.reduce((s, c) => s + Number(c.amount) - Number(c.paid_amount), 0);
  if (balance <= 0) return;
  const realId = clientKey === "unassigned" ? null : clientKey;
  await db().from("payments").insert({ business_id: b.id, client_id: realId, amount: balance, paid_on: new Date().toISOString().slice(0, 10), status: "paid" });
  for (const c of rows) await db().from("charges").update({ paid_amount: c.amount, status: "paid" }).eq("id", c.id);
  revalidatePath("/dashboard");
}

/** "They don't actually owe this" — void the open charges, no payment recorded. */
export async function voidBalance(formData: FormData) {
  const clientKey = String(formData.get("clientId"));
  const b = await getBusiness();
  const rows = await openChargesFor(b.id, clientKey);
  for (const c of rows) await db().from("charges").update({ status: "void" }).eq("id", c.id);
  revalidatePath("/dashboard");
}

export async function reminderAction(formData: FormData) {
  const id = String(formData.get("reminderId"));
  const action = String(formData.get("action"));
  const b = await getBusiness();
  if (action === "snooze") {
    const due = new Date();
    due.setDate(due.getDate() + 3);
    due.setHours(9, 0, 0, 0);
    await db().from("reminders").update({ due_at: due.toISOString() }).eq("id", id).eq("business_id", b.id);
  } else if (action === "done") {
    await db().from("reminders").update({ status: "done" }).eq("id", id).eq("business_id", b.id);
  } else if (action === "cancel") {
    await db().from("reminders").update({ status: "cancelled" }).eq("id", id).eq("business_id", b.id);
  }
  revalidatePath("/dashboard");
}
