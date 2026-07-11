import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — lightweight readiness check (for uptime monitors).
 * Verifies the app boots and the database is reachable. No secrets exposed.
 */
export async function GET() {
  try {
    const { error } = await db().from("businesses").select("id").limit(1);
    if (error) throw error;
    // Dead-man's switch: this endpoint is pinged independently (UptimeRobot), so
    // use it to notice if the reminder cron pinger has gone quiet. Best-effort.
    const { checkCronHeartbeat, getCronHealth } = await import("@/lib/heartbeat");
    await checkCronHeartbeat();
    const cron = await getCronHealth(); // exposed for diagnostics; no secrets
    return NextResponse.json({ ok: true, db: true, time: new Date().toISOString(), cronSecondsAgo: cron.secondsAgo });
  } catch (e) {
    console.error("[health] db check failed:", e);
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
}
