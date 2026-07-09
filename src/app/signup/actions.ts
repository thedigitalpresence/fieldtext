"use server";

import { headers } from "next/headers";
import { db } from "@/lib/supabase";
import { sendSms } from "@/lib/twilio";
import { toE164 } from "@/lib/phone";

// The exact consent sentence shown next to the checkbox — stored verbatim as
// proof-of-consent (what carriers ask for in an A2P dispute). This is the
// WRITTEN half of double opt-in; texting the number is the mobile-originated half.
export const CONSENT_TEXT =
  "I agree to receive recurring SMS text messages from FieldText at the mobile number I provided, to log and " +
  "manage my business, including confirmations, quote and job reminders, follow-up nudges, and account " +
  "notifications. Message frequency varies. Message & data rates may apply. Reply STOP to opt out and HELP for " +
  "help. Consent is not a condition of any purchase. See our Privacy Policy and Terms.";

export interface SignupResult { ok: boolean; error?: string }

export async function submitSignup(_prev: SignupResult | null, formData: FormData): Promise<SignupResult> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  const business = String(formData.get("business") ?? "").trim().slice(0, 200);
  const phoneRaw = String(formData.get("phone") ?? "").trim().slice(0, 40);
  const language = String(formData.get("language")) === "es" ? "es" : "en";
  const consented = formData.get("consent") === "on";
  if (!name || !business || !phoneRaw) return { ok: false, error: "Please fill in every field." };
  if (!consented) return { ok: false, error: "Please check the consent box so we can text you." };

  const phone = toE164(phoneRaw);
  if (!phone) return { ok: false, error: `That phone number doesn't look right: "${phoneRaw}"` };
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Already registered? Don't create a duplicate pending signup.
  const { data: existingPhone } = await db().from("authorized_phones").select("id").eq("phone", phone).maybeSingle();
  if (existingPhone) return { ok: true }; // already an operator — treat as success

  const { error } = await db().from("signups").insert({
    name, business_name: business, phone, language,
    status: "pending",
    consent_text: CONSENT_TEXT,
    consented_at: new Date().toISOString(),
    ip,
  });
  if (error) {
    console.error("[signup] insert failed:", error.message);
    return { ok: false, error: "Something went wrong — please try again." };
  }

  // Ping the founder so no lead ever sits unseen (best-effort; never blocks the signup).
  const alertTo = process.env.FOUNDER_ALERT_PHONE || process.env.OWNER_PHONE;
  if (alertTo) {
    try {
      await sendSms(alertTo, `🌱 New FieldText signup: ${name}, ${business}, ${phone}`);
    } catch (e) {
      console.error("[signup] founder alert failed:", e);
    }
  }
  return { ok: true };
}
