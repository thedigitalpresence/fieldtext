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
const STALE_MIN = 15; // pinger runs every 1 min; 15 min of silence = it's down
const ALERT_COOLDOWN_MIN = 60; // don't re-nag more than hourly while it's down

/** Stamp "the pinger just ran". Called from /api/cron/run-due after auth. */
export async function recordCronRun(): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { data } = await db().from("system_state").select("value").eq("key", KEY).maybeSingle();
    const value = { ...((data?.value as Record<string, unknown>) ?? {}), lastRunAt: now };
    await db().from("system_state").upsert({ key: KEY, value, updated_at: now });
  } catch (e) {
    console.error("[heartbeat] record failed:", e);
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
    const { alertFounder } = await import("./security");
    await alertFounder(
      "cron-heartbeat",
      `Reminder pinger looks DOWN — no run in ${mins} min. Reminders and quote follow-ups won't fire until it's back. Check your cron-job.org job.`,
    );
    await db().from("system_state").upsert({
      key: KEY,
      value: { ...v, lastAlertAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[heartbeat] check failed:", e);
  }
}
