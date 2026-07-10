import { redirect } from "next/navigation";
import { db, currentSession } from "@/lib/supabase";
import WaitlistClient, { type Lead } from "./WaitlistClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Beta waitlist" };

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

export default async function WaitlistPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");

  const { data } = await db()
    .from("waitlist")
    .select("id, created_at, name, business_name, phone, trade, needs, language, timezone, status, notes")
    .order("created_at", { ascending: false });

  const leads: Lead[] = ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    name: r.name,
    business: r.business_name,
    phone: fmtPhone(r.phone),
    rawPhone: r.phone,
    trade: r.trade,
    needs: r.needs,
    lang: r.language === "es" ? "ES" : "EN",
    timezone: shortTz(r.timezone),
    status: r.status,
    notes: r.notes,
  }));

  return <WaitlistClient leads={leads} />;
}

function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
function shortTz(tz: string): string {
  return (
    {
      "America/Los_Angeles": "Pacific",
      "America/Denver": "Mountain",
      "America/Phoenix": "Arizona",
      "America/Chicago": "Central",
      "America/New_York": "Eastern",
      "America/Anchorage": "Alaska",
      "Pacific/Honolulu": "Hawaii",
    }[tz] ?? tz
  );
}
