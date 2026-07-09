/**
 * SMS password reset. The phone number is the username, so we text a 6-digit
 * code to it (proving control), then let them set a new password.
 *   requestReset  -> texts a code (silent about whether the number exists)
 *   completeReset -> verifies the code and sets the new hashed password
 */
import { randomInt } from "node:crypto";
import { db, getBusinessById } from "./supabase";
import { sendSms } from "./twilio";
import { businessLang, t } from "./templates";
import { hashPassword, verifyPassword } from "./password";
import { clearFailures } from "./security";

const CODE_TTL_MIN = 15;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

interface ResetRow {
  phone: string; business_id: string | null; code_hash: string;
  expires_at: string; attempts: number; used: boolean; created_at: string;
}

/**
 * Text a reset code to a registered number. Always resolves the same way whether
 * or not the number exists (no account enumeration). Respects a resend cooldown.
 */
export async function requestReset(phone: string): Promise<void> {
  // Primary phone only: the dashboard password belongs to the OWNER. A crew
  // phone on the account must not be able to reset (and thus take over) it.
  const { data: ap } = await db().from("authorized_phones").select("business_id")
    .eq("phone", phone).eq("is_primary", true).maybeSingle();
  const businessId = (ap as { business_id: string } | null)?.business_id;
  if (!businessId) return; // unknown number: stay silent

  // Daily cap on reset texts per phone (on top of the 60s cooldown) so the
  // form can't be scripted into an SMS-bombing tool.
  const { throttleStatus, recordFailure } = await import("./security");
  if ((await throttleStatus(`reset:${phone}`)) > 0) return;
  await recordFailure(`reset:${phone}`);

  const { data: existing } = await db().from("password_resets").select("*").eq("phone", phone).maybeSingle();
  const prev = existing as ResetRow | null;
  if (prev && Date.now() - new Date(prev.created_at).getTime() < RESEND_COOLDOWN_MS) return; // anti-spam

  const code = String(randomInt(100000, 1000000));
  const row = {
    phone, business_id: businessId, code_hash: hashPassword(code),
    expires_at: new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString(),
    attempts: 0, used: false, created_at: new Date().toISOString(),
  };
  if (prev) await db().from("password_resets").update(row).eq("phone", phone);
  else await db().from("password_resets").insert(row);

  const biz = await getBusinessById(businessId);
  const lang = businessLang(biz);
  try { await sendSms(phone, t.resetCode(code, lang)); } catch (e) { console.error("[reset] sms failed:", e); }
}

export interface ResetResult { ok: boolean; error?: string }

export async function completeReset(phone: string, code: string, newPassword: string): Promise<ResetResult> {
  if (newPassword.length < 6) return { ok: false, error: "Password must be at least 6 characters." };
  const { data } = await db().from("password_resets").select("*").eq("phone", phone).maybeSingle();
  const r = data as ResetRow | null;
  if (!r || r.used) return { ok: false, error: "No reset in progress. Request a new code." };
  if (new Date(r.expires_at).getTime() < Date.now()) return { ok: false, error: "That code expired. Request a new one." };
  if (r.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: "Too many tries. Request a new code." };

  if (!verifyPassword(code.trim(), r.code_hash)) {
    await db().from("password_resets").update({ attempts: r.attempts + 1 }).eq("phone", phone);
    return { ok: false, error: "Incorrect code." };
  }
  if (!r.business_id) return { ok: false, error: "Something went wrong. Try again." };

  await db().from("businesses").update({ dashboard_password: hashPassword(newPassword) }).eq("id", r.business_id);
  await db().from("password_resets").update({ used: true }).eq("phone", phone);
  await clearFailures(phone); // lift any login lockout
  return { ok: true };
}
