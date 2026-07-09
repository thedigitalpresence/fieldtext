/**
 * GET/POST /api/cron/backup — snapshot the whole database to Supabase Storage.
 * Auth: same CRON_SECRET as run-due. Point a WEEKLY cron-job.org job here.
 *
 * Writes one timestamped JSON to the private "backups" bucket and keeps the most
 * recent BACKUP_KEEP. This protects against bad edits / accidental deletes. (For
 * full disaster recovery, also enable Supabase Pro point-in-time backups.)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { db } from "@/lib/supabase";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "backups";
const BACKUP_KEEP = 8;
const TABLES = [
  "businesses", "authorized_phones", "clients", "jobs", "payments", "charges",
  "expenses", "reminders", "messages", "attachments", "invoices", "signups", "billing_events",
];

function authorized(req: NextRequest): boolean {
  const secret = config.cronSecret();
  return req.headers.get("authorization") === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (config.testMode()) return NextResponse.json({ ok: true, skipped: "test mode" });

  const storage = createClient(config.supabase.url(), config.supabase.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await storage.storage.createBucket(BUCKET, { public: false }).catch(() => {});

  const snapshot: Record<string, unknown[]> = {};
  let rowCount = 0;
  for (const table of TABLES) {
    const { data, error } = await db().from(table).select("*");
    if (error) { console.warn(`[backup] ${table}: ${error.message}`); continue; }
    snapshot[table] = data ?? [];
    rowCount += (data ?? []).length;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `snapshot-${stamp}.json`;
  const { error: upErr } = await storage.storage
    .from(BUCKET)
    .upload(path, JSON.stringify({ takenAt: new Date().toISOString(), tables: snapshot }, null, 0), {
      contentType: "application/json",
    });
  if (upErr) {
    const { alertFounder } = await import("@/lib/security");
    await alertFounder("backup", `weekly backup failed: ${upErr.message.slice(0, 100)}`);
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  // Prune old snapshots.
  const { data: list } = await storage.storage.from(BUCKET).list("", { limit: 100, sortBy: { column: "name", order: "desc" } });
  const old = (list ?? []).filter((f) => f.name.startsWith("snapshot-")).slice(BACKUP_KEEP).map((f) => f.name);
  if (old.length) await storage.storage.from(BUCKET).remove(old);

  return NextResponse.json({ ok: true, path, rows: rowCount, pruned: old.length });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
