import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";
import { testDb } from "./testdb";
import type { Business, AuthorizedPhone } from "./types";

/**
 * Server-only Supabase client (SERVICE ROLE key — bypasses RLS, full access).
 * Never import into client components. In LOCAL_TEST mode returns a file-backed
 * mock that speaks the same query API (no Supabase/Docker needed).
 */
let _client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (config.testMode()) return testDb() as unknown as SupabaseClient;
  if (_client) return _client;
  _client = createClient(config.supabase.url(), config.supabase.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export async function getBusiness(slug?: string): Promise<Business> {
  const wanted = slug || config.defaultBusinessSlug();
  const { data, error } = await db().from("businesses").select("*").eq("slug", wanted).single();
  if (error || !data) throw new Error(`Business not found for slug "${wanted}": ${error?.message ?? "no row"}`);
  return data as Business;
}

/**
 * The business the current dashboard session is acting on.
 *   business session → that business.
 *   admin session    → the one selected via the ft_biz cookie, else the default.
 * Reads cookies, so only call from server components / server actions.
 */
export async function currentBusiness(): Promise<Business> {
  const { cookies } = await import("next/headers");
  const { verifySession, parseSession } = await import("./auth");
  const session = parseSession(await verifySession(cookies().get("ft_auth")?.value));
  if (session?.kind === "business") return getBusinessById(session.businessId);
  if (session?.kind === "admin") {
    const sel = cookies().get("ft_biz")?.value;
    if (sel) {
      try { return await getBusinessById(sel); } catch { /* fall through to default */ }
    }
  }
  return getBusiness();
}

/** Every business, for the admin switcher / registration list. */
export async function listBusinesses(): Promise<Business[]> {
  const { data } = await db().from("businesses").select("*").order("created_at", { ascending: true });
  return (data ?? []) as Business[];
}

/** The verified session (admin / business / null). Server-only (reads cookies). */
export async function currentSession() {
  const { cookies } = await import("next/headers");
  const { verifySession, parseSession } = await import("./auth");
  return parseSession(await verifySession(cookies().get("ft_auth")?.value));
}

export async function getBusinessById(id: string): Promise<Business> {
  const { data, error } = await db().from("businesses").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`Business ${id} not found`);
  return data as Business;
}

/** Look up the authorized phone (and its business). null if the number isn't authorized. */
export async function findAuthorizedPhone(phone: string): Promise<AuthorizedPhone | null> {
  const { data } = await db().from("authorized_phones").select("*").eq("phone", phone).maybeSingle();
  return (data as AuthorizedPhone) ?? null;
}

/** The phone that should receive reminders/nudges/digest for a business. */
export async function getPrimaryPhone(businessId: string): Promise<AuthorizedPhone | null> {
  const { data: rows } = await db()
    .from("authorized_phones")
    .select("*")
    .eq("business_id", businessId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const list = (rows ?? []) as AuthorizedPhone[];
  return list[0] ?? null;
}
