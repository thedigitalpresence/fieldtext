"use server";

import { revalidatePath } from "next/cache";
import { db, currentSession } from "@/lib/supabase";

const STATUSES = ["new", "invited", "active", "passed"] as const;

/** Move a lead through new → invited → active (or passed). Founder only. */
export async function setWaitlistStatus(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (session?.kind !== "admin") return;
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !STATUSES.includes(status as (typeof STATUSES)[number])) return;
  await db().from("waitlist").update({ status }).eq("id", id);
  revalidatePath("/dashboard/waitlist");
}

/** Save the founder's private note on a lead. Founder only. */
export async function saveWaitlistNote(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (session?.kind !== "admin") return;
  const id = String(formData.get("id") ?? "");
  const notes = String(formData.get("notes") ?? "").slice(0, 2000);
  if (!id) return;
  await db().from("waitlist").update({ notes: notes || null }).eq("id", id);
  revalidatePath("/dashboard/waitlist");
}

/** Remove a lead (spam / duplicate). Founder only. */
export async function deleteWaitlistEntry(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (session?.kind !== "admin") return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await db().from("waitlist").delete().eq("id", id);
  revalidatePath("/dashboard/waitlist");
}
