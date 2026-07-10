"use server";

import { randomInt } from "node:crypto";
import { headers } from "next/headers";
import { db } from "@/lib/supabase";
import { toE164 } from "@/lib/phone";
import { hashPassword } from "@/lib/password";

// The exact consent sentence shown next to the checkbox — stored verbatim as
// proof-of-consent (what carriers ask for in an A2P dispute). This is the
// WRITTEN half of double opt-in; texting the number is the mobile-originated half.
export const CONSENT_TEXT =
  "I agree to receive recurring SMS text messages from FieldText at the mobile number I provided, to log and " +
  "manage my business, including confirmations, quote and job reminders, follow-up nudges, and account " +
  "notifications. Message frequency varies. Message & data rates may apply. Reply STOP to opt out and HELP for " +
  "help. Consent is not a condition of any purchase. See our Privacy Policy and Terms.";

export interface SignupResult { ok: boolean; error?: string; code?: string }

// ─────────────────────────────────────────────────────────────────────────────
// BETA WAITLIST (active front door right now)
//
// During beta the public /signup form does NOT create an account. It saves a
// LEAD to the `waitlist` table and tells the person we'll reach out. The founder
// reviews leads in /dashboard/waitlist and hand-picks who to invite; only then
// does an account get created. The full account-creation flow below
// (submitSignup) is preserved intact for when we flip to open self-serve signup.
// ─────────────────────────────────────────────────────────────────────────────
export interface WaitlistResult { ok: boolean; error?: string }

export async function submitWaitlist(_prev: WaitlistResult | null, formData: FormData): Promise<WaitlistResult> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  const business = String(formData.get("business") ?? "").trim().slice(0, 200);
  const phoneRaw = String(formData.get("phone") ?? "").trim().slice(0, 40);
  const trade = String(formData.get("trade") ?? "").trim().slice(0, 200);
  const needs = String(formData.get("needs") ?? "").trim().slice(0, 1000);
  const language = String(formData.get("language")) === "es" ? "es" : "en";
  const TIMEZONES = [
    "America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago",
    "America/New_York", "America/Anchorage", "Pacific/Honolulu",
  ];
  const tzRaw = String(formData.get("timezone") ?? "");
  const timezone = TIMEZONES.includes(tzRaw) ? tzRaw : "America/Los_Angeles";
  const consented = formData.get("consent") === "on";
  if (!name || !phoneRaw || !trade) return { ok: false, error: "Please fill in your name, number, and what you do." };
  if (!consented) return { ok: false, error: "Please check the box so we can text you about the beta." };

  const phone = toE164(phoneRaw);
  if (!phone) return { ok: false, error: `That phone number doesn't look right: "${phoneRaw}"` };
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Same blunt anti-spam throttle as the real signup.
  const { throttleStatus, recordFailure, alertFounder } = await import("@/lib/security");
  if ((await throttleStatus("waitlist-global")) > 0) {
    return { ok: false, error: "We're getting a lot of signups right now. Please try again in a few minutes." };
  }
  await recordFailure("waitlist-global", 60);

  // One lead per phone: update the existing row instead of stacking duplicates.
  const { data: prior } = await db().from("waitlist").select("id, status").eq("phone", phone).maybeSingle();
  const row = {
    name, business_name: business || null, phone, trade, needs: needs || null,
    language, timezone,
    consent_text: CONSENT_TEXT,
    consented_at: new Date().toISOString(),
    ip,
  };
  const { error } = prior
    ? await db().from("waitlist").update(row).eq("id", (prior as { id: string }).id)
    : await db().from("waitlist").insert({ ...row, status: "new" });
  if (error) {
    console.error("[waitlist] insert failed:", error.message);
    return { ok: false, error: "Something went wrong — please try again." };
  }

  // Ping the founder so no lead sits unseen (deduped per phone; best-effort).
  await alertFounder(
    `waitlist:${phone}`,
    `📝 Beta waitlist: ${name}${business ? `, ${business}` : ""} — ${trade} — ${phone}`,
  );
  return { ok: true };
}

export async function submitSignup(_prev: SignupResult | null, formData: FormData): Promise<SignupResult> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  const business = String(formData.get("business") ?? "").trim().slice(0, 200);
  const phoneRaw = String(formData.get("phone") ?? "").trim().slice(0, 40);
  const language = String(formData.get("language")) === "es" ? "es" : "en";
  const TIMEZONES = [
    "America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago",
    "America/New_York", "America/Anchorage", "Pacific/Honolulu",
  ];
  const tzRaw = String(formData.get("timezone") ?? "");
  const timezone = TIMEZONES.includes(tzRaw) ? tzRaw : "America/Los_Angeles";
  const dashboardPassword = String(formData.get("password") ?? "").trim().slice(0, 100);
  const consented = formData.get("consent") === "on";
  if (!name || !business || !phoneRaw) return { ok: false, error: "Please fill in every field." };
  if (!dashboardPassword || dashboardPassword.length < 6) return { ok: false, error: "Choose a password of at least 6 characters." };
  if (!consented) return { ok: false, error: "Please check the consent box so we can text you." };

  const phone = toE164(phoneRaw);
  if (!phone) return { ok: false, error: `That phone number doesn't look right: "${phoneRaw}"` };
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Global signup throttle: blunt but effective against form-spam floods.
  const { throttleStatus, recordFailure } = await import("@/lib/security");
  if ((await throttleStatus("signup-global")) > 0) {
    return { ok: false, error: "We're getting a lot of signups right now. Please try again in a few minutes." };
  }
  await recordFailure("signup-global", 30); // >30 signups per window trips the lock

  // Already registered? Don't create a duplicate pending signup.
  const { data: existingPhone } = await db().from("authorized_phones").select("id").eq("phone", phone).maybeSingle();
  if (existingPhone) return { ok: true }; // already an operator — treat as success

  // Activation code: shown ONLY on the success screen. Texting it proves the
  // form-filler controls this phone — a stranger's phone can't be squatted.
  const code = String(randomInt(100000, 1000000));

  // One pending signup per phone: replace any earlier one (prevents stacking).
  const { data: prior } = await db().from("signups").select("id").eq("phone", phone).eq("status", "pending").maybeSingle();
  const row = {
    name, business_name: business, phone, language, timezone,
    dashboard_password: hashPassword(dashboardPassword),
    activation_code: hashPassword(code),
    status: "pending",
    consent_text: CONSENT_TEXT,
    consented_at: new Date().toISOString(),
    ip,
  };
  const { error } = prior
    ? await db().from("signups").update(row).eq("id", (prior as { id: string }).id)
    : await db().from("signups").insert(row);
  if (error) {
    console.error("[signup] insert failed:", error.message);
    return { ok: false, error: "Something went wrong — please try again." };
  }

  // Ping the founder so no lead ever sits unseen (deduped per phone; best-effort).
  const { alertFounder } = await import("@/lib/security");
  await alertFounder(`signup:${phone}`, `🌱 New FieldText signup: ${name}, ${business}, ${phone}`);
  return { ok: true, code };
}
