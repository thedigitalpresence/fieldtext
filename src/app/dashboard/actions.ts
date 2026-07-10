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
import { applyPaymentToCharges, reversePaymentFromCharges } from "@/lib/charges";
import { normalizeAmount, normalizeName, normalizeAddress, computeNextService } from "@/lib/normalize";
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

  const phone = toE164(phoneRaw);

  // Founder master key → admin session (phone not needed). The master-key check
  // runs on EVERY login, so its throttle must be a FIXED global bucket — keyed
  // per-phone it could be bypassed by rotating phone numbers. Generous limit
  // (paired with alertFounder on lock) balances brute-force vs founder DoS.
  const masterLocked = await throttleStatus("admin-master");
  if (masterLocked === 0 && safeEqual(password, config.dashboardPassword())) {
    cookies().set(AUTH_COOKIE, await signSession("admin"), COOKIE_OPTS);
    redirect(dest);
  }

  // Operator: their PHONE NUMBER is the username, matched to their business.
  // Web login is the OWNER's (primary phone) — crew phones text, they don't log in.
  if (phone) {
    const phoneLocked = await throttleStatus(phone);
    if (phoneLocked > 0) fail(phoneLocked);
    const { data: ap } = await db().from("authorized_phones").select("business_id").eq("phone", phone).eq("is_primary", true).maybeSingle();
    const businessId = (ap as { business_id: string } | null)?.business_id;
    if (businessId) {
      const { data: biz } = await db().from("businesses").select("dashboard_password").eq("id", businessId).maybeSingle();
      const stored = (biz as { dashboard_password: string | null } | null)?.dashboard_password;
      if (verifyPassword(password, stored)) {
        await clearFailures(phone);
        cookies().set(AUTH_COOKIE, await signSession(`b:${businessId}`), COOKIE_OPTS);
        cookies().delete("ft_biz");
        redirect(dest);
      }
    }
    await recordFailure(phone);
  }
  // Every failed login also counts against the master bucket (the master key was
  // implicitly tested above), with a generous threshold.
  await recordFailure("admin-master", 30);
  fail(masterLocked > 0 ? masterLocked : undefined);
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

/** Set (or clear) the forecast city. Geocoded once here; lat/lon ride in settings. */
export async function setCity(formData: FormData) {
  const b = await currentBusiness();
  const city = String(formData.get("city") ?? "").trim().slice(0, 80);
  const settings = { ...(b.settings ?? {}) };
  if (!city) {
    delete settings.city; delete settings.lat; delete settings.lon;
    await db().from("businesses").update({ settings }).eq("id", b.id);
    revalidatePath("/dashboard");
    return;
  }
  const { geocodeCity } = await import("@/lib/weather");
  const geo = await geocodeCity(city);
  if (!geo) redirect("/dashboard?cityerr=1");
  await db().from("businesses").update({
    settings: { ...settings, city: geo.label, lat: geo.lat, lon: geo.lon },
  }).eq("id", b.id);
  revalidatePath("/dashboard");
  // Full redirect so a stale ?cityerr=1 from an earlier failed try is cleared —
  // otherwise the error banner (and the reopened form) haunt every refresh.
  redirect("/dashboard");
}

export async function markStatus(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const status = String(formData.get("status")) as ClientStatus;
  const b = await currentBusiness();
  await db().from("clients").update({ status, updated_at: new Date().toISOString() }).eq("id", clientId).eq("business_id", b.id);
  if (status !== "quoted") await cancelQuoteReminders(clientId, b.id);
  revalidatePath("/dashboard");
}

/** True only if the client row belongs to this business (clientId is a form value — never trust it). */
async function ownsClient(businessId: string, clientId: string): Promise<boolean> {
  if (!clientId) return false;
  const { data } = await db().from("clients").select("id").eq("id", clientId).eq("business_id", businessId).maybeSingle();
  return !!data;
}

export async function addNote(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const note = String(formData.get("note") ?? "").trim();
  if (!note) return;
  const b = await currentBusiness();
  const { data } = await db().from("clients").select("notes").eq("id", clientId).eq("business_id", b.id).maybeSingle();
  if (!data) return;
  const existing = (data as { notes: string | null }).notes ?? "";
  const merged = existing ? `${existing}\n${note}` : note;
  await db().from("clients").update({ notes: merged, updated_at: new Date().toISOString() }).eq("id", clientId).eq("business_id", b.id);
  revalidatePath("/dashboard");
}

export async function addReminderAction(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;
  const b = await currentBusiness();
  if (!(await ownsClient(b.id, clientId))) return;
  // Optional date + time from the form, interpreted in the BUSINESS timezone.
  // No date given → the old default: three days out at 9 AM.
  const date = String(formData.get("date") ?? "").trim();
  const time = String(formData.get("time") ?? "").trim();
  let dueISO: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const hhmm = /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : "09:00";
    dueISO = dueAtInTz(date, hhmm, b.timezone || "America/New_York");
  } else {
    const due = new Date();
    due.setDate(due.getDate() + 3);
    due.setHours(9, 0, 0, 0);
    dueISO = due.toISOString();
  }
  await createReminder({ businessId: b.id, clientId, text, dueISO, kind: "manual" });
  revalidatePath("/dashboard");
}

export async function logPayment(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const amount = normalizeAmount(String(formData.get("amount") ?? ""));
  if (amount == null) return;
  const b = await currentBusiness();
  if (!(await ownsClient(b.id, clientId))) return;
  await db().from("payments").insert({ business_id: b.id, client_id: clientId, amount, paid_on: new Date().toISOString().slice(0, 10) });
  // Settle open charges oldest-first so the dashboard payment moves "Money owed"
  // exactly like the texted "bob paid 300" does.
  await applyPaymentToCharges(b.id, clientId, amount);
  revalidatePath("/dashboard");
}

/** Edit a client's core fields from the dashboard. Empty text field = cleared. */
export async function editClient(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const b = await currentBusiness();
  const { data: cur } = await db().from("clients").select("*").eq("id", clientId).eq("business_id", b.id).maybeSingle();
  if (!cur) return;
  const c = cur as { service_interval: string | null; service_day: string | null };
  const val = (k: string) => { const v = formData.get(k); return v == null ? "" : String(v).trim(); };
  const amtRaw = val("amount");
  const patch: Record<string, unknown> = {
    name: normalizeName(val("name")) ?? undefined,
    address: val("address") ? normalizeAddress(val("address")) : null,
    phone: val("phone") || null,
    service_description: val("service") || null,
    notes: val("notes") || null,
    amount: amtRaw ? normalizeAmount(amtRaw) ?? null : null,
    billing_period: val("billing_period") || null,
    updated_at: new Date().toISOString(),
  };
  if (!patch.name) delete patch.name; // never blank the name
  // Service cadence: only touch the schedule when it actually CHANGED, so fixing
  // a typo in the name doesn't silently reset a client's next-visit date.
  const interval = val("service_interval");
  const day = val("service_day");
  if ((c.service_interval ?? "") !== interval || (c.service_day ?? "") !== day) {
    patch.service_interval = interval || null;
    patch.service_day = day || null;
    patch.next_service_on = interval
      ? computeNextService(interval as "weekly" | "biweekly" | "monthly", day || null, new Date().toISOString()) ?? null
      : null;
  }
  await db().from("clients").update(patch).eq("id", clientId).eq("business_id", b.id);
  revalidatePath("/dashboard");
}

/** "YYYY-MM-DD at HH:MM in the business's timezone" → UTC ISO. (±1h on DST switch days is fine for reminders.) */
function dueAtInTz(dateStr: string, timeStr: string, tz: string): string {
  const guess = new Date(`${dateStr}T${timeStr}:00Z`);
  const wall = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
  return new Date(guess.getTime() + (guess.getTime() - wall.getTime())).toISOString();
}

/** Delete a payment AND give the money back to the ledger (mistake eraser). */
export async function deletePayment(formData: FormData) {
  const id = String(formData.get("paymentId"));
  const b = await currentBusiness();
  const { data } = await db().from("payments").select("*").eq("id", id).eq("business_id", b.id).maybeSingle();
  if (!data) return;
  const p = data as { client_id: string | null; amount: number };
  await db().from("payments").delete().eq("id", id).eq("business_id", b.id);
  if (p.client_id) await reversePaymentFromCharges(b.id, p.client_id, Number(p.amount));
  revalidatePath("/dashboard");
}

export async function deleteJob(formData: FormData) {
  const id = String(formData.get("jobId"));
  const b = await currentBusiness();
  await db().from("jobs").delete().eq("id", id).eq("business_id", b.id);
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
