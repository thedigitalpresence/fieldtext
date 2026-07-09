import { redirect } from "next/navigation";
import { db, currentSession, listBusinesses } from "@/lib/supabase";
import AdminClient from "./AdminClient";
import type { AuthorizedPhone } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

export default async function AdminPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");

  const businesses = await listBusinesses();
  const { data: phoneRows } = await db().from("authorized_phones").select("*");
  const phones = (phoneRows ?? []) as AuthorizedPhone[];

  const rows = businesses.map((b) => {
    const primary = phones.find((p) => p.business_id === b.id && p.is_primary) ?? phones.find((p) => p.business_id === b.id);
    return {
      id: b.id,
      name: b.name,
      owner: b.owner_name,
      lang: b.settings?.language === "es" ? "ES" : "EN",
      phone: primary ? fmtPhone(primary.phone) : "—",
      hasPassword: Boolean((b as { dashboard_password?: string }).dashboard_password),
    };
  });

  return <AdminClient businesses={rows} />;
}

function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
