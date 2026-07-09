import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifySession } from "@/lib/auth";
import { parseTextHeuristic, parseCsv, extractClientsLLM, extractClientsFromImage } from "@/lib/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authed(req: NextRequest): Promise<boolean> {
  return Boolean(await verifySession(req.cookies.get("ft_auth")?.value));
}

/**
 * POST /api/import/parse — turn a paste / CSV / photo into DRAFT clients.
 * FormData: method = "text" | "csv" | "photo", plus `text` and/or `file`.
 * Returns { drafts: ClientDraft[], error?: string }. Nothing is saved here.
 */
export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const method = String(form.get("method") ?? "text");

  try {
    if (method === "text") {
      const text = String(form.get("text") ?? "");
      const drafts = config.llmDryRun() ? parseTextHeuristic(text) : await extractClientsLLM(text);
      return NextResponse.json({ drafts });
    }
    if (method === "csv") {
      const file = form.get("file") as File | null;
      const text = file ? await file.text() : String(form.get("text") ?? "");
      return NextResponse.json({ drafts: parseCsv(text) });
    }
    if (method === "photo") {
      if (config.llmDryRun()) return NextResponse.json({ drafts: [], error: "photo_needs_key" });
      const file = form.get("file") as File | null;
      if (!file) return NextResponse.json({ drafts: [], error: "no_file" });
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      const drafts = await extractClientsFromImage(base64, file.type || "image/jpeg");
      return NextResponse.json({ drafts });
    }
    return NextResponse.json({ drafts: [], error: "unknown_method" }, { status: 400 });
  } catch (e) {
    console.error("[import/parse] error:", e);
    return NextResponse.json({ drafts: [], error: "parse_failed" }, { status: 500 });
  }
}
