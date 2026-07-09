/**
 * Self-service activation. When an unknown number texts the FieldText number, we
 * check for a pending signup (written web consent) matching that phone. If found,
 * that inbound text IS the mobile-originated opt-in — the second half of double
 * opt-in — so we create the operator's isolated business and mark the signup
 * activated. From then on their texts route to their own book.
 */
import { db } from "./supabase";
import type { AuthorizedPhone, Lang } from "./types";

interface Signup {
  id: string; name: string | null; business_name: string | null; phone: string | null;
  language: string | null; status: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "biz";
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 2; i < 60; i++) {
    const { data } = await db().from("businesses").select("id").eq("slug", slug).maybeSingle();
    if (!data) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Math.floor(Date.now() % 100000)}`;
}

/**
 * Activate a consented signup for this phone, returning the new authorized phone
 * (so the inbound handler can process the very same message). null if no pending
 * signup matches.
 */
export async function activateSignup(phone: string): Promise<AuthorizedPhone | null> {
  const { data } = await db().from("signups").select("*").eq("phone", phone).eq("status", "pending").limit(1);
  const signup = ((data ?? []) as Signup[])[0];
  if (!signup) return null;

  const lang: Lang = signup.language === "es" ? "es" : "en";
  const now = new Date().toISOString();
  const name = (signup.name || "Owner").trim();
  const bizName = (signup.business_name || `${name}'s business`).trim();
  const slug = await uniqueSlug(slugify(signup.business_name || name));

  const { data: biz, error } = await db().from("businesses").insert({
    slug, name: bizName, owner_name: name, timezone: "America/Los_Angeles",
    settings: { language: lang, quote_reminder_days: [2, 5, 7, 14], weekly_digest_enabled: true },
    created_at: now,
  }).select("*").single();
  if (error || !biz) {
    console.error("[onboarding] activation business insert failed:", error?.message);
    return null;
  }
  const businessId = (biz as { id: string }).id;

  const { data: ap } = await db().from("authorized_phones").insert({
    business_id: businessId, phone, label: `${name} cell`, is_primary: true, opted_out: false, language: lang,
    created_at: now,
  }).select("*").single();

  await db().from("signups").update({ status: "activated", activated_at: now, business_id: businessId }).eq("id", signup.id);
  return (ap as AuthorizedPhone) ?? null;
}
