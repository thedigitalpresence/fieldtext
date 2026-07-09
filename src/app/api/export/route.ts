/**
 * GET /api/export?what=clients|payments|jobs|expenses — CSV download.
 * Cookie-authed like the import routes. The customer's data is theirs:
 * this doubles as their backup and their exit door.
 */
import { NextRequest, NextResponse } from "next/server";
import { db, currentBusiness } from "@/lib/supabase";
import { openBalances } from "@/lib/charges";
import { verifySession } from "@/lib/auth";
import type { Client } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  // Guard Excel formula injection AND quote correctly.
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

export async function GET(req: NextRequest) {
  if (!(await verifySession(req.cookies.get("ft_auth")?.value))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const business = await currentBusiness();
  const what = req.nextUrl.searchParams.get("what") ?? "clients";

  let csv = "";
  if (what === "payments") {
    const { data } = await db().from("payments").select("*").eq("business_id", business.id).order("created_at", { ascending: true });
    const { data: clientRows } = await db().from("clients").select("*").eq("business_id", business.id);
    const nameOf = (id: string | null) => ((clientRows ?? []) as Client[]).find((c) => c.id === id)?.name ?? "";
    csv = toCsv(
      ["date", "client", "amount", "method", "status"],
      ((data ?? []) as Record<string, unknown>[]).map((p) => [p.paid_on ?? String(p.created_at ?? "").slice(0, 10), nameOf(p.client_id as string | null), p.amount, p.method, p.status])
    );
  } else if (what === "jobs") {
    const { data } = await db().from("jobs").select("*").eq("business_id", business.id).order("created_at", { ascending: true });
    const { data: clientRows } = await db().from("clients").select("*").eq("business_id", business.id);
    const nameOf = (id: string | null) => ((clientRows ?? []) as Client[]).find((c) => c.id === id)?.name ?? "";
    csv = toCsv(
      ["date", "client", "description", "amount", "status"],
      ((data ?? []) as Record<string, unknown>[]).map((j) => [j.performed_on ?? j.scheduled_on, nameOf(j.client_id as string | null), j.description, j.amount, j.status])
    );
  } else if (what === "expenses") {
    const { data } = await db().from("expenses").select("*").eq("business_id", business.id).order("spent_on", { ascending: true });
    csv = toCsv(
      ["date", "amount", "category", "description"],
      ((data ?? []) as Record<string, unknown>[]).map((e) => [e.spent_on, e.amount, e.category, e.description])
    );
  } else {
    // The black book itself.
    const [{ data }, balances] = await Promise.all([
      db().from("clients").select("*").eq("business_id", business.id).order("created_at", { ascending: true }),
      openBalances(business.id),
    ]);
    const balanceOf = (id: string) => balances.find((b) => b.client_id === id)?.balance ?? 0;
    csv = toCsv(
      ["name", "address", "phone", "email", "status", "amount", "billing_period", "service", "schedule", "service_day", "next_visit", "balance_owed", "referred_by", "notes"],
      ((data ?? []) as Client[]).map((c) => [
        c.name, c.address, c.phone, c.email, c.status, c.amount, c.billing_period, c.service_description,
        c.service_interval, c.service_day, c.next_service_on, balanceOf(c.id) || "", c.referred_by, c.notes,
      ])
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fieldtext-${what}-${today}.csv"`,
    },
  });
}
