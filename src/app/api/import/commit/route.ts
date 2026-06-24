import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getBusiness } from "@/lib/supabase";
import { commitDrafts } from "@/lib/import";
import type { ClientDraft } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  return req.cookies.get("ft_auth")?.value === config.dashboardPassword();
}

/**
 * POST /api/import/commit — save the operator's REVIEWED drafts as clients.
 * Body: { drafts: ClientDraft[] }. Returns { count }.
 */
export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { drafts } = (await req.json()) as { drafts: ClientDraft[] };
    if (!Array.isArray(drafts) || drafts.length === 0) return NextResponse.json({ count: 0 });
    const business = await getBusiness();
    const count = await commitDrafts(business, drafts.slice(0, 500));
    return NextResponse.json({ count });
  } catch (e) {
    console.error("[import/commit] error:", e);
    return NextResponse.json({ error: "commit_failed" }, { status: 500 });
  }
}
