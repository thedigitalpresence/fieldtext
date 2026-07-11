import { db } from "./supabase";

/**
 * Cron dead-man's switch. run-due stamps a heartbeat every time it runs (every
 * minute via the external pinger). /api/health — pinged independently by
 * UptimeRobot every 5 min — checks that heartbeat; if it's gone stale, the
 * reminder pinger is down, so we text the founder. Both sides are best-effort:
 * any failure (incl. the table not existing yet) is swallowed so neither
 * run-due nor the health check can break.
 */
const KEY = "cron:run-due";
const STALE_MIN = 20; // pinger runs every 1 min; 20 min of silence = it's really down
const ALERT_COOLDOWN_MIN = 60; // don't re-nag more than hourly while it's down

/** Stamp "the pinger just ran". Called from /api/cron/run-due after auth. */
export async function recordCronRun(): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { data } = await db().from("system_state").select("value").eq("key", KEY).maybeSingle();
    const value = { ...((data?.value as Record<string, unknown>) ?? {}), lastRunAt: now };
    // Explicit update-or-insert (upsert onConflict was unreliable): guarantees
    // lastRunAt actually advances, otherwise the health check false-alarms.
    const res = data
      ? await db().from("system_state").update({ value, updated_at: now }).eq("key", KEY)
      : await db().from("system_state").insert({ key: KEY, value, updated_at: now });
    if (res.error) console.error("[heartbeat] record write failed:", res.error.message);
  } catch (e) {
    console.error("[heartbeat] record failed:", e);
  }
}

export interface CronHealth {
  reporting: boolean; // have we ever seen a heartbeat? (false if migration not run / never pinged)
  lastRunAt: string | null;
  secondsAgo: number | null;
}

/** Read the cron heartbeat for the founder dashboard. Best-effort. */
export async function getCronHealth(): Promise<CronHealth> {
  try {
    const { data } = await db().from("system_state").select("value").eq("key", KEY).maybeSingle();
    const v = (data?.value as { lastRunAt?: string }) ?? {};
    if (!v.lastRunAt) return { reporting: false, lastRunAt: null, secondsAgo: null };
    return { reporting: true, lastRunAt: v.lastRunAt, secondsAgo: Math.round((Date.now() - new Date(v.lastRunAt).getTime()) / 1000) };
  } catch {
    return { reporting: false, lastRunAt: null, secondsAgo: null };
  }
}

/** If the pinger has gone quiet, text the founder (deduped hourly). Called from /api/health. */
export async function checkCronHeartbeat(): Promise<void> {
  try {
    const { data } = await db().from("system_state").select("value").eq("key", KEY).maybeSingle();
    const v = (data?.value as { lastRunAt?: string; lastAlertAt?: string }) ?? {};
    if (!v.lastRunAt) return; // never stamped yet (fresh deploy / migration not run)

    const now = Date.now();
    const staleMs = now - new Date(v.lastRunAt).getTime();
    if (staleMs < STALE_MIN * 60_000) return; // healthy

    if (v.lastAlertAt && now - new Date(v.lastAlertAt).getTime() < ALERT_COOLDOWN_MIN * 60_000) return; // already warned recently

    const mins = Math.round(staleMs / 60_000);
    // Save the alert time FIRST so we don't double-fire if the SMS is slow.
    await db().from("system_state").update({
      value: { ...v, lastAlertAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).eq("key", KEY);
    const { alertFounder } = await import("./security");
    await alertFounder(
      "cron-heartbeat",
      `Reminder pinger looks DOWN. No run in ${mins} min, so reminders and quote follow-ups won't fire until it's back. Check your cron-job.org job.`,
    );
  } catch (e) {
    console.error("[heartbeat] check failed:", e);
  }
}
