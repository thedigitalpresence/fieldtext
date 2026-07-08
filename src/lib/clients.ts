import { db } from "./supabase";
import { levenshtein } from "./normalize";
import type { Client, ClientStatus } from "./types";

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// Articles/honorifics carry no identity: "los garcia" must match "Dee Garcia".
const NAME_NOISE = new Set(["the", "los", "las", "el", "la", "mr", "mrs", "ms", "dr", "sr", "sra", "don", "dona"]);
function nameTokens(s: string): string[] {
  return s.split(" ").filter((t) => t && !NAME_NOISE.has(t));
}
/** Typo tolerance scaled to length, first letter must agree ("gary" ≠ "mary"). */
function typoClose(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4 || a[0] !== b[0]) return false;
  const budget = Math.min(a.length, b.length) >= 5 ? 2 : 1; // "smtih"~"smith" (transposition = 2 edits)
  return levenshtein(a, b) <= budget;
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

export interface ScoredMatch { client: Client; score: number }

/**
 * A score at or above this means the name genuinely matched (exact/substring).
 * Below it, the hit came only from a shared token or a typo bonus — e.g.
 * "Eric Shackelford" hitting "Elena Shackelford" on the last name — and the
 * caller should CONFIRM with the operator instead of silently attaching data.
 */
export const STRONG_MATCH = 3;

/**
 * Fuzzy-match a client by name and/or address, with scores. Sorted best-first;
 * only candidates close to the best are kept (a clear winner isn't drowned out).
 */
export async function matchClientsScored(
  businessId: string,
  opts: { name?: string; address?: string }
): Promise<ScoredMatch[]> {
  const all = await listClients(businessId);
  const qName = norm(opts.name);
  const qAddr = norm(opts.address);
  if (!qName && !qAddr) return [];

  const scored = all
    .map((c) => ({ client: c, score: score(c, qName, qAddr) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];
  const best = scored[0].score;
  return scored.filter((x) => x.score >= best - 1);
}

/** Back-compat: just the clients. Empty = no match; >1 = ambiguous. */
export async function matchClients(
  businessId: string,
  opts: { name?: string; address?: string }
): Promise<Client[]> {
  return (await matchClientsScored(businessId, opts)).map((x) => x.client);
}

/** Pure name+address match score (exported for tests). Higher = better match. */
export function matchScore(query: { name?: string; address?: string }, cand: { name: string; address?: string | null }): number {
  return score({ name: cand.name, address: cand.address ?? null } as Client, norm(query.name), norm(query.address));
}

function score(c: Client, qName: string, qAddr: string): number {
  let s = 0;
  if (qName) {
    const cName = norm(c.name);
    let nameScore = 0;
    if (cName === qName) nameScore = 5;
    else if (cName.includes(qName) || qName.includes(cName)) nameScore = 3;
    else {
      const qT = nameTokens(qName);
      const cT = nameTokens(cName);

      if (qT.length >= 2 && cT.length >= 2) {
        // Both are FULL names: identity lives in the LAST name. Different last
        // names = different people — "Eric Mitchell" must never surface
        // "Eric Shackelford", no matter how many Erics are in the book.
        const qLast = qT[qT.length - 1];
        const cLast = cT[cT.length - 1];
        const lastMatch = qLast === cLast || typoClose(qLast, cLast);
        if (lastMatch) {
          const qFirst = qT[0];
          const cFirst = cT[0];
          const firstMatch = qFirst === cFirst || typoClose(qFirst, cFirst);
          // Same full name (modulo typos) = strong; same family only = weak (confirm).
          nameScore = firstMatch ? 4 : 2;
        }
        // else: 0 — not a candidate.
      } else {
        // Single-token query ("garcia", "smtih"): an exact surname hit is a
        // strong identity signal (two Garcias still trigger the ambiguity ask);
        // a typo hit stays weak (confirm first).
        const cSet = new Set(cT);
        const overlap = qT.filter((t) => t.length > 1 && cSet.has(t)).length;
        nameScore = overlap * 3;
        if (overlap === 0) {
          for (const qt of qT) {
            if (cT.some((ct) => typoClose(qt, ct))) { nameScore = 2; break; }
          }
        }
      }
    }
    // A FULL-name mismatch is a veto: "Eric Mitchell at 5 Oak St" must never
    // surface "The Smiths at 12 Oak St" off street-word overlap.
    if (nameScore === 0 && nameTokens(qName).length >= 2) return 0;
    s += nameScore;
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
  return { quoted: "Quoted", active: "Active", completed: "Completed", lost: "Lost", paused: "Paused" }[s];
}
