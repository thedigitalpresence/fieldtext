import { NextRequest, NextResponse } from "next/server";
import { runAllDue } from "@/lib/reminders";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Generates billing-cycle charges, sends due reminders + follow-up nudges +
 * day sheet / weekly / monthly digests. Triggered by Vercel Cron daily on Hobby
 * (vercel.json) — pair with an external 10–15 min pinger (LAUNCH.md) for
 * on-time reminders. Vercel auto-sends
 * `Authorization: Bearer <CRON_SECRET>`. Manual run:
 *   curl -X POST http://localhost:3000/api/cron/run-due -H "x-cron-secret: $CRON_SECRET"
 */
function authorized(req: NextRequest): boolean {
  const secret = config.cronSecret();
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const summary = await runAllDue();
  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
