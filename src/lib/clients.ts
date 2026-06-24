import { db } from "./supabase";
import { levenshtein } from "./normalize";
import type { Client, ClientStatus } from "./types";

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// Common street words carry no identifying signal — two unrelated addresses both
// containing "st" must NOT be treated as a match.
const ADDR_STOPWORDS = new Set([
  "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane",
  "blvd", "ct", "court", "way", "pl", "place", "cir", "circle", "ter", "terrace",
  "n", "s", "e", "w", "north", "south", "east", "west", "apt", "unit", "the",
]);

export async function listClients(businessId: string): Promise<Client[]> {
  const { data } = await db()
    .from("clients")
    .select("*")
    .eq("business_id", businessId)
    .order("updated_at", { ascending: false });
  return (data ?? []) as Client[];
}

/**
 * Fuzzy-match a client by name and/or address. Returns candidates sorted by score
 * (best first). An empty result means "no match"; more than one means "ambiguous".
 */
export async function matchClients(
  businessId: string,
  opts: { name?: string; address?: string }
): Promise<Client[]> {
  const all = await listClients(businessId);
  const qName = norm(opts.name);
  const qAddr = norm(opts.address);
  if (!qName && !qAddr) return [];

  const scored = all
    .map((c) => ({ c, score: score(c, qName, qAddr) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Keep only matches close to the best (so a clear winner isn't drowned out).
  if (scored.length === 0) return [];
  const best = scored[0].score;
  return scored.filter((x) => x.score >= best - 1).map((x) => x.c);
}

/** Pure name+address match score (exported for tests). Higher = better match. */
export function matchScore(query: { name?: string; address?: string }, cand: { name: string; address?: string | null }): number {
  return score({ name: cand.name, address: cand.address ?? null } as Client, norm(query.name), norm(query.address));
}

function score(c: Client, qName: string, qAddr: string): number {
  let s = 0;
  if (qName) {
    const cName = norm(c.name);
    if (cName === qName) s += 5;
    else if (cName.includes(qName) || qName.includes(cName)) s += 3;
    else {
      const cT = cName.split(" ");
      const cSet = new Set(cT);
      const overlap = qName.split(" ").filter((t) => t.length > 1 && t !== "the" && cSet.has(t)).length;
      s += overlap * 2;
      // Typo tolerance: a query token within small edit distance of a candidate
      // token counts (smtih ~ smith). Only for tokens long enough to be meaningful.
      if (overlap === 0) {
        for (const qt of qName.split(" ")) {
          if (qt.length < 4 || qt === "the") continue;
          if (cT.some((ct) => ct.length >= 4 && levenshtein(qt, ct) <= 2)) { s += 2; break; }
        }
      }
    }
  }
  if (qAddr && c.address) {
    const cAddr = norm(c.address);
    if (cAddr === qAddr) s += 5;
    else if (cAddr.includes(qAddr) || qAddr.includes(cAddr)) s += 3;
    else {
      const cT = new Set(cAddr.split(" "));
      // Only count meaningful tokens — skip street words and tiny tokens (house
      // numbers, "st") that produce false matches between unrelated addresses.
      const overlap = qAddr
        .split(" ")
        .filter((t) => t.length >= 3 && !ADDR_STOPWORDS.has(t) && cT.has(t)).length;
      s += overlap;
    }
  }
  return s;
}

export async function createClient(
  businessId: string,
  fields: Partial<Client> & { name: string }
): Promise<Client> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from("clients")
    .insert({
      business_id: businessId,
      name: fields.name,
      address: fields.address ?? null,
      status: fields.status ?? "quoted",
      service_description: fields.service_description ?? null,
      amount: fields.amount ?? null,
      billing_period: fields.billing_period ?? null,
      notes: fields.notes ?? null,
      service_interval: fields.service_interval ?? null,
      service_day: fields.service_day ?? null,
      next_service_on: fields.next_service_on ?? null,
      updated_at: now,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Failed to create client: ${error?.message}`);
  return data as Client;
}

export async function updateClient(id: string, patch: Partial<Client>): Promise<Client | null> {
  const { data } = await db()
    .from("clients")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  return (data as Client) ?? null;
}

export function statusLabel(s: ClientStatus): string {
  return { quoted: "Quoted", active: "Active", completed: "Completed", lost: "Lost" }[s];
}
