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
