/**
 * Client import — load an operator's existing book fast, three ways:
 *   • bulk text / paste   (one client per line)
 *   • CSV upload          (header-mapped)
 *   • photo / OCR         (vision via Claude — needs ANTHROPIC_API_KEY)
 *
 * Every method produces DRAFT clients that the operator reviews and edits before
 * anything is saved (see /api/import/commit). Imported clients default to "active"
 * (they're an existing book, not new quotes). One shared normalization pipeline.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import {
  normalizeName, normalizeAddress, normalizeAmount, normalizePeriod, normalizeService,
  normalizeServiceInterval, normalizeWeekday, NormalizeContext,
} from "./normalize";
import { createClient } from "./clients";
import type { Business, ClientDraft } from "./types";

let _anthropic: Anthropic | null = null;
function anthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: config.anthropic.apiKey() });
  return _anthropic;
}

// ── Normalize one raw draft (from any source) into clean canonical fields ─────
function normalizeDraft(raw: Record<string, any>): ClientDraft | null {
  const name = normalizeName(raw.name != null ? String(raw.name) : "");
  if (!name) return null; // a draft with no name is useless
  return {
    name,
    address: normalizeAddress(raw.address != null ? String(raw.address) : undefined),
    amount: raw.amount != null ? normalizeAmount(raw.amount) : undefined,
    billing_period: normalizePeriod(raw.billing_period != null ? String(raw.billing_period) : undefined),
    service_description: normalizeService(raw.service_description != null ? String(raw.service_description) : undefined),
    service_interval: normalizeServiceInterval(raw.service_interval != null ? String(raw.service_interval) : undefined),
    service_day: normalizeWeekday(raw.service_day != null ? String(raw.service_day) : undefined),
    status: "active",
  };
}

// ── Heuristic line parser: "smiths 12 oak 300/mo mowing" -> draft ─────────────
export function parseClientLine(line: string): Record<string, any> | null {
  const s = line.replace(/[\t,;|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // Name = leading words before the first number.
  const nameM = s.match(/^([a-zà-ÿ&][a-zà-ÿ .'’&-]*?)(?=\s+\$?\d|\s*$)/i);
  const name = nameM ? nameM[1].trim() : s;
  let rest = nameM ? s.slice(nameM[1].length).trim() : "";

  // Find numbers in the rest. First = house number (address), a later one = amount.
  let address: string | undefined, amount: string | undefined, billing: string | undefined, service: string | undefined;

  // amount: prefer $-prefixed or one tied to a period word.
  const amtRe = /(\$\s?[\d,]+(?:\.\d+)?|\b[\d,]+(?:\.\d+)?\s*\/?\s*(?:mo|month|wk|week|yr|year|mes|sem|semana)\b)/i;
  const amtM = rest.match(amtRe);
  if (amtM && amtM.index != null) {
    address = rest.slice(0, amtM.index).trim() || undefined;
    amount = amtM[1];
    billing = amtM[1];
    service = rest.slice(amtM.index + amtM[1].length).trim() || undefined;
  } else {
    // No marked amount: two numbers => [house#] [amount]; one number => house# only.
    const nums = [...rest.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)];
    if (nums.length >= 2) {
      const last = nums[nums.length - 1];
      address = rest.slice(0, last.index).trim() || undefined;
      amount = last[0];
      service = rest.slice(last.index! + last[0].length).trim() || undefined;
    } else {
      address = rest || undefined;
    }
  }

  return { name, address, amount, billing_period: billing, service_description: service };
}

export function parseTextHeuristic(text: string): ClientDraft[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseClientLine(l))
    .map((raw) => (raw ? normalizeDraft(raw) : null))
    .filter((d): d is ClientDraft => d != null);
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
const HEADER_MAP: Record<string, keyof ClientDraft> = {
  name: "name", client: "name", customer: "name",
  address: "address", addr: "address", location: "address",
  amount: "amount", price: "amount", rate: "amount", cost: "amount",
  period: "billing_period", billing: "billing_period", frequency: "billing_period",
  service: "service_description", description: "service_description", notes: "service_description",
  interval: "service_interval", schedule: "service_interval",
  day: "service_day",
};
export function parseCsv(text: string): ClientDraft[] {
  const rows = text.split(/\r?\n/).filter((r) => r.trim());
  if (rows.length === 0) return [];
  const header = splitCsvLine(rows[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const hasHeader = header.some((h) => HEADER_MAP[h]);
  const cols = hasHeader ? header.map((h) => HEADER_MAP[h]) : ["name", "address", "amount", "service_description"] as (keyof ClientDraft | undefined)[];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  return dataRows
    .map((r) => {
      const cells = splitCsvLine(r);
      const raw: Record<string, any> = {};
      cells.forEach((cell, i) => { const key = cols[i]; if (key && cell) raw[key] = cell; });
      return normalizeDraft(raw);
    })
    .filter((d): d is ClientDraft => d != null);
}

// ── LLM extraction (text + photo). Tool-calling => array of client drafts ─────
const DRAFT_PROPS = {
  name: { type: "string" },
  address: { type: "string" },
  amount: { type: "number", description: "Numeric, no $." },
  billing_period: { type: "string", enum: ["one_time", "weekly", "biweekly", "monthly"] },
  service_description: { type: "string" },
  service_interval: { type: "string", enum: ["weekly", "biweekly", "monthly"] },
  service_day: { type: "string" },
};
const IMPORT_TOOL = {
  name: "record_clients",
  description: "Record the list of existing clients extracted from the operator's notes/photo.",
  input_schema: {
    type: "object" as const,
    properties: { clients: { type: "array", items: { type: "object", properties: DRAFT_PROPS, required: ["name"] } } },
    required: ["clients"],
  },
};
const IMPORT_SYSTEM =
  "You extract a landscaping operator's EXISTING client list from messy notes, invoices, or a photo. " +
  "Each entry has a client name and may include address, recurring amount + period (monthly/weekly/biweekly), " +
  "service description, and a service schedule (interval + weekday). Be tolerant of abbreviations and bad handwriting. " +
  "Return one client per row via record_clients. Do not invent data you can't see.";

export async function extractClientsLLM(text: string): Promise<ClientDraft[]> {
  const resp = await anthropic().messages.create({
    model: config.anthropic.model(),
    max_tokens: 4000,
    system: IMPORT_SYSTEM,
    tools: [IMPORT_TOOL],
    tool_choice: { type: "tool", name: "record_clients" },
    messages: [{ role: "user", content: text }],
  });
  return draftsFromResponse(resp);
}

export async function extractClientsFromImage(base64: string, mediaType: string): Promise<ClientDraft[]> {
  const resp = await anthropic().messages.create({
    model: config.anthropic.model(),
    max_tokens: 4000,
    system: IMPORT_SYSTEM,
    tools: [IMPORT_TOOL],
    tool_choice: { type: "tool", name: "record_clients" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } },
          { type: "text", text: "Extract every client from this image into record_clients." },
        ],
      },
    ],
  });
  return draftsFromResponse(resp);
}

function draftsFromResponse(resp: Anthropic.Message): ClientDraft[] {
  const toolUse = resp.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return [];
  const raw = (toolUse.input as { clients?: any[] }).clients ?? [];
  return raw.map((r) => normalizeDraft(r)).filter((d): d is ClientDraft => d != null);
}

// ── Commit reviewed drafts ────────────────────────────────────────────────────
export async function commitDrafts(business: Business, drafts: ClientDraft[]): Promise<number> {
  let n = 0;
  for (const d of drafts) {
    const name = normalizeName(d.name);
    if (!name) continue;
    await createClient(business.id, {
      name,
      address: d.address ?? null,
      amount: d.amount ?? null,
      billing_period: d.billing_period ?? null,
      service_description: d.service_description ?? null,
      service_interval: d.service_interval ?? null,
      service_day: d.service_day ?? null,
      status: d.status ?? "active",
    });
    n++;
  }
  return n;
}

export type { ClientDraft, NormalizeContext };
