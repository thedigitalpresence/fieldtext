import { db } from "@/lib/supabase";
import type { Lead } from "./WaitlistClient";

type Row = {
  id: string;
  created_at: string;
  name: string;
  business_name: string | null;
  phone: string;
  trade: string | null;
  needs: string | null;
  language: string;
  timezone: string;
  status: string;
  notes: string | null;
};

const TZ_SHORT: Record<string, string> = {
  "America/Los_Angeles": "Pacific",
  "America/Denver": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Chicago": "Central",
  "America/New_York": "Eastern",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** All waitlist leads, newest first, mapped for the UI. Shared by the standalone
 *  waitlist page and the HQ command center so they never drift. */
export async function loadWaitlistLeads(): Promise<Lead[]> {
  const { data } = await db()
    .from("waitlist")
    .select("id, created_at, name, business_name, phone, trade, needs, language, timezone, status, notes")
    .order("created_at", { ascending: false });

  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    name: r.name,
    business: r.business_name,
    phone: fmtPhone(r.phone),
    rawPhone: r.phone,
    trade: r.trade,
    needs: r.needs,
    lang: r.language === "es" ? "ES" : "EN",
    timezone: TZ_SHORT[r.timezone] ?? r.timezone,
    status: r.status,
    notes: r.notes,
  }));
}
