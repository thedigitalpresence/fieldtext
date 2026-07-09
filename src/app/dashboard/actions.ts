"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { config } from "@/lib/config";
import { AUTH_COOKIE } from "@/middleware";
import { db, currentBusiness } from "@/lib/supabase";
import { createReminder, cancelQuoteReminders } from "@/lib/reminders";
import { signSession, verifySession, parseSession } from "@/lib/auth";
import { hashPassword, verifyPassword, safeEqual } from "@/lib/password";
import { throttleStatus, recordFailure, clearFailures } from "@/lib/security";
import { normalizeAmount, normalizeName, normalizeAddress } from "@/lib/normalize";
import { toE164 } from "@/lib/phone";
import type { ChargeStatus, ClientStatus, Lang } from "@/lib/types";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export async function login(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const next = String(formData.get("next") ?? "/dashboard");
  const dest = next.startsWith("/dashboard") ? next : "/dashboard";
  const fail = (locked?: number) =>
    redirect(`/dashboard/login?error=${locked ? "locked" : "1"}${locked ? `&mins=${locked}` : ""}&next=${encodeURIComponent(next)}`);

  if (!password) fail();

  // Rate limit per identifier (phone, or "admin" for the master key attempt).
  const phone = toE164(phoneRaw);
  const idKey = phone ?? "admin";
  const locked = await throttleStatus(idKey);
  if (locked > 0) fail(locked);

  // Founder master key → admin session (phone not needed).
  if (safeEqual(password, config.dashboardPassword())) {
    await clearFailures(idKey);
    cookies().set(AUTH_COOKIE, await signSession("admin"), COOKIE_OPTS);
    redirect(dest);
  }

  // Operator: their PHONE NUMBER is the username, matched to their business.
  if (phone) {
    const { data: ap } = await db().from("authorized_phones").select("business_id").eq("phone", phone).maybeSingle();
    const businessId = (ap as { business_id: string } | null)?.business_id;
    if (businessId) {
      const { data: biz } = await db().from("businesses").select("dashboard_password").eq("id", businessId).maybeSingle();
      const stored = (biz as { dashboard_password: string | null } | null)?.dashboard_password;
      if (verifyPassword(password, stored)) {
        await clearFailures(idKey);
        cookies().set(AUTH_COOKIE, await signSession(`b:${businessId}`), COOKIE_OPTS);
        cookies().delete("ft_biz");
        redirect(dest);
      }
    }
  }

  await recordFailure(idKey);
  fail();
}

export async function logout() {
  cookies().delete(AUTH_COOKIE);
  cookies().delete("ft_biz");
  redirect("/dashboard/login");
}

/** Step 1 of SMS reset: text a code to the number (silent whether or not it exists). */
export async function requestResetAction(_prev: unknown, formData: FormData): Promise<{ sent: boolean; phone: string; error?: string }> {
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const phone = toE164(phoneRaw);
  if (!phone) return { sent: false, phone: "", error: "That phone number doesn't look right." };
  const { requestReset } = await import("@/lib/reset");
  await requestReset(phone);
  return { sent: true, phone };
}

/** Step 2 of SMS reset: verify the code and set the new password. */
export async function completeResetAction(_prev: unknown, formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const phone = toE164(String(formData.get("phone") ?? "").trim());
  const code = String(formData.get("code") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!phone) return { ok: false, error: "Start over and enter your number again." };
  const { completeReset } = await import("@/lib/reset");
  const res = await completeReset(phone, code, password);
  if (res.ok) redirect("/dashboard/login?reset=1");
  return res;
}

/** Admin only: set/reset a business's dashboard password (grant dashboard access). */
export async function setBusinessPassword(formData: FormData) {
  const session = parseSession(await verifySession(cookies().get(AUTH_COOKIE)?.value));
  if (session?.kind !== "admin") return;
  const businessId = String(formData.get("businessId") ?? "");
  const password = String(formData.get("password") ?? "").trim();
  if (businessId && password.length >= 6) {
    await db().from("businesses").update({ dashboard_password: hashPassword(password) }).eq("id", businessId);
  }
  revalidatePath("/dashboard/admin");
}

/** Admin only: pick which business's book to view. */
export async function switchBusiness(formData: FormData) {
  const session = parseSession(await verifySession(cookies().get(AUTH_COOKIE)?.value));
  if (session?.kind !== "admin") return;
  const businessId = String(formData.get("businessId") ?? "");
  if (businessId) cookies().set("ft_biz", businessId, COOKIE_OPTS);
  redirect("/dashboard");
}

/** Admin only: register a new operator = new isolated business + authorized phone. */
export async function registerOperator(_prev: unknown, formData: FormData): Promise<{ ok: boolean; error?: string; slug?: string }> {
  const session = parseSession(await verifySession(cookies().get(AUTH_COOKIE)?.value));
  if (session?.kind !== "admin") return { ok: false, error: "Admins only." };

  const ownerName = String(formData.get("ownerName") ?? "").trim();
  const businessName = String(formData.get("businessName") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();
  const lang = (String(formData.get("lang")) === "es" ? "es" : "en") as Lang;
  const timezone = String(formData.get("timezone") ?? "America/Los_Angeles").trim() || "America/Los_Angeles";
  if (!ownerName || !businessName || !phoneRaw || !password) return { ok: false, error: "Please fill in every field." };
  if (password.length < 6) return { ok: false, error: "Give them a dashboard password of at least 6 characters." };

  const phone = toE164(phoneRaw);
  if (!phone) return { ok: false, error: `That phone number doesn't look right: "${phoneRaw}"` };

  // Phone must be globally unique (it's how inbound texts route to a business).
  const { data: existingPhone } = await db().from("authorized_phones").select("id").eq("phone", phone).maybeSingle();
  if (existingPhone) return { ok: false, error: "That phone is already registered to a business." };

  const base = businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "biz";
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data: taken } = await db().from("businesses").select("id").eq("slug", slug).maybeSingle();
    if (!taken) break;
    slug = `${base}-${i}`;
  }

  const { data: biz, error } = await db().from("businesses").insert({
    slug, name: businessName, owner_name: ownerName, timezone,
    dashboard_password: hashPassword(password),
    settings: { language: lang, quote_reminder_days: [2, 5, 7, 14], weekly_digest_enabled: true },
    created_at: new Date().toISOString(),
  }).select("*").single();
  if (error || !biz) return { ok: false, error: `Couldn't create the business: ${error?.message ?? "unknown"}` };

  await db().from("authorized_phones").insert({
    business_id: (biz as { id: string }).id,
    phone, label: `${ownerName} cell`, is_primary: true, opted_out: false, language: lang,
    created_at: new Date().toISOString(),
  });
  return { ok: true, slug };
}

// ── Dashboard mutations (tap equivalents of the text actions) ─────────────────

export async function setLanguage(formData: FormData) {
  const lang = (String(formData.get("lang")) === "es" ? "es" : "en") as Lang;
  const b = await currentBusiness();
  await db().from("businesses").update({ settings: { ...(b.settings ?? {}), language: lang } }).eq("id", b.id);
  revalidatePath("/dashboard");
}

export async function markStatus(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const status = String(formData.get("status")) as ClientStatus;
  const b = await currentBusiness();
  await db().from("clients").update({ status, updated_at: new Date().toISOString() }).eq("id", clientId).eq("business_id", b.id);
  if (status !== "quoted") await cancelQuoteReminders(clientId);
  revalidatePath("/dashboard");
}

export async function addNote(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return;
  const b = await currentBusiness();
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
  const b = await currentBusiness();
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
  const b = await currentBusiness();
  await db().from("payments").insert({ business_id: b.id, client_id: clientId, amount, paid_on: new Date().toISOString().slice(0, 10) });
  revalidatePath("/dashboard");
}

/** Edit a client's core fields from the dashboard. Empty text field = cleared. */
export async function editClient(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const b = await currentBusiness();
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
  const b = await currentBusiness();
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
  const b = await currentBusiness();
  const rows = await openChargesFor(b.id, clientKey);
  for (const c of rows) await db().from("charges").update({ status: "void" }).eq("id", c.id);
  revalidatePath("/dashboard");
}

export async function reminderAction(formData: FormData) {
  const id = String(formData.get("reminderId"));
  const action = String(formData.get("action"));
  const b = await currentBusiness();
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
