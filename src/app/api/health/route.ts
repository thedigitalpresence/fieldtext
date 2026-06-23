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
    return NextResponse.json({ ok: true, db: true, time: new Date().toISOString() });
  } catch (e) {
    console.error("[health] db check failed:", e);
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
}
