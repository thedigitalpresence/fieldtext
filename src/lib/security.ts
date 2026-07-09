/**
 * Login throttling + operator failure alerts.
 *
 * Throttle: after MAX_FAILS failed logins for an identifier (phone or "admin"),
 * lock it for LOCK_MINUTES. Backed by the auth_throttle table so it holds across
 * serverless instances.
 *
 * alertFounder: best-effort SMS to the founder when something breaks, deduped so
 * a storm of the same error doesn't blow up your phone (or your SMS bill).
 */
import { db } from "./supabase";
import { sendSms } from "./twilio";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

interface ThrottleRow { id_key: string; fails: number; locked_until: string | null }

/** Returns minutes remaining if locked, else 0. */
export async function throttleStatus(idKey: string): Promise<number> {
  const { data } = await db().from("auth_throttle").select("*").eq("id_key", idKey).maybeSingle();
  const row = data as ThrottleRow | null;
  if (!row?.locked_until) return 0;
  const ms = new Date(row.locked_until).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

export async function recordFailure(idKey: string, maxFails: number = MAX_FAILS): Promise<void> {
  const { data } = await db().from("auth_throttle").select("*").eq("id_key", idKey).maybeSingle();
  const row = data as ThrottleRow | null;
  const fails = (row?.fails ?? 0) + 1;
  const locked = fails >= maxFails ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
  const patch = { id_key: idKey, fails: locked ? 0 : fails, locked_until: locked, updated_at: new Date().toISOString() };
  if (row) await db().from("auth_throttle").update(patch).eq("id_key", idKey);
  else await db().from("auth_throttle").insert(patch);
  if (locked && (idKey === "admin-master" || idKey === "admin")) {
    await alertFounder("lockout", `repeated failed admin login attempts — locked ${LOCK_MINUTES} min. Someone may be guessing your master password.`);
  }
}

export async function clearFailures(idKey: string): Promise<void> {
  const { data } = await db().from("auth_throttle").select("id_key").eq("id_key", idKey).maybeSingle();
  if (data) await db().from("auth_throttle").update({ fails: 0, locked_until: null, updated_at: new Date().toISOString() }).eq("id_key", idKey);
}

export const LOCK_MINUTES_PUBLIC = LOCK_MINUTES;

// ── Failure alerts ────────────────────────────────────────────────────────────
const lastAlert = new Map<string, number>();
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/** Text the founder that something failed. Deduped per `key` for 10 minutes. */
export async function alertFounder(key: string, message: string): Promise<void> {
  const to = process.env.FOUNDER_ALERT_PHONE || process.env.OWNER_PHONE;
  if (!to) return;
  const now = Date.now();
  const last = lastAlert.get(key) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  lastAlert.set(key, now);
  try {
    await sendSms(to, `⚠️ FieldText: ${message}`.slice(0, 300));
  } catch (e) {
    console.error("[security] founder alert failed:", e);
  }
}
