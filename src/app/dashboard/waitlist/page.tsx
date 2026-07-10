import { redirect } from "next/navigation";
import { currentSession } from "@/lib/supabase";
import WaitlistClient from "./WaitlistClient";
import { loadWaitlistLeads } from "./data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Beta waitlist" };

export default async function WaitlistPage() {
  const session = await currentSession();
  if (session?.kind !== "admin") redirect("/dashboard");
  const leads = await loadWaitlistLeads();
  return <WaitlistClient leads={leads} />;
}
