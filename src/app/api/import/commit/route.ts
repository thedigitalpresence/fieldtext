import { NextRequest, NextResponse } from "next/server";
import { currentBusiness } from "@/lib/supabase";
import { verifySession } from "@/lib/auth";
import { commitDrafts } from "@/lib/import";
import type { ClientDraft } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authed(req: NextRequest): Promise<boolean> {
  return Boolean(await verifySession(req.cookies.get("ft_auth")?.value));
}

/**
 * POST /api/import/commit — save the operator's REVIEWED drafts as clients.
 * Body: { drafts: ClientDraft[] }. Returns { count }.
 */
export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { drafts } = (await req.json()) as { drafts: ClientDraft[] };
    if (!Array.isArray(drafts) || drafts.length === 0) return NextResponse.json({ count: 0 });
    const business = await currentBusiness();
    const count = await commitDrafts(business, drafts.slice(0, 500));
    return NextResponse.json({ count });
  } catch (e) {
    console.error("[import/commit] error:", e);
    return NextResponse.json({ error: "commit_failed" }, { status: 500 });
  }
}
