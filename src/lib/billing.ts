/**
 * Usage/cost logging — an OPTIONAL component, on by default, that records the
 * running cost of operating FieldText: each inbound/outbound SMS segment and each
 * LLM call, with an estimated USD cost.
 *
 * Turn it OFF per-business (settings.billing_enabled = false) or globally
 * (env BILLING_ENABLED=false). When off, every function here is a no-op, so the
 * rest of the app doesn't need to know whether billing is enabled.
 */
import { db } from "./supabase";
import { config } from "./config";
import type { Business, BillingEvent, LlmUsage } from "./types";

// LLM price per 1M tokens (input / output). Keep in sync with your Anthropic plan.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export function billingEnabled(business: Business): boolean {
  if (!config.billingEnabledGlobally()) return false;
  return business.settings?.billing_enabled !== false; // default ON
}

/** Twilio bills per 160-char (GSM) segment; ~153 for multi-part concatenation. */
export function smsSegments(body: string): number {
  const len = (body ?? "").length;
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

function modelPrice(model: string) {
  return MODEL_PRICES[model] ?? MODEL_PRICES["claude-opus-4-8"];
}

async function insertEvent(e: Partial<BillingEvent> & { business_id: string; event_type: string; cost_usd: number }) {
  const { error } = await db().from("billing_events").insert(e);
  if (error) console.error("[billing] insert failed:", error.message);
}

export async function logSms(
  business: Business,
  args: { direction: "inbound" | "outbound"; body: string; messageId?: string | null }
): Promise<void> {
  if (!billingEnabled(business)) return;
  const segments = smsSegments(args.body);
  await insertEvent({
    business_id: business.id,
    event_type: args.direction === "inbound" ? "sms_inbound" : "sms_outbound",
    sms_segments: segments,
    cost_usd: round5(segments * config.smsCostPerSegment()),
    message_id: args.messageId ?? null,
  });
}

export async function logLlm(
  business: Business,
  kind: "llm_parse" | "llm_query",
  usage: LlmUsage | null
): Promise<void> {
  if (!billingEnabled(business) || !usage) return;
  const p = modelPrice(usage.model);
  const cost = (usage.inputTokens / 1e6) * p.in + (usage.outputTokens / 1e6) * p.out;
  await insertEvent({
    business_id: business.id,
    event_type: kind,
    model: usage.model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: round5(cost),
  });
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

export interface BillingSummary {
  enabled: boolean;
  periodLabel: string;
  smsCount: number;
  llmCount: number;
  smsCost: number;
  llmCost: number;
  totalCost: number;
}

/** Aggregate this calendar month's usage for the dashboard. */
export async function billingSummary(business: Business, now = new Date()): Promise<BillingSummary> {
  if (!billingEnabled(business)) {
    return { enabled: false, periodLabel: "", smsCount: 0, llmCount: 0, smsCost: 0, llmCost: 0, totalCost: 0 };
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data } = await db()
    .from("billing_events")
    .select("*")
    .eq("business_id", business.id)
    .gte("created_at", monthStart);
  const events = (data ?? []) as BillingEvent[];

  let smsCount = 0, llmCount = 0, smsCost = 0, llmCost = 0;
  for (const e of events) {
    if (e.event_type.startsWith("sms")) { smsCount++; smsCost += Number(e.cost_usd); }
    else { llmCount++; llmCost += Number(e.cost_usd); }
  }
  return {
    enabled: true,
    periodLabel: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    smsCount,
    llmCount,
    smsCost: round5(smsCost),
    llmCost: round5(llmCost),
    totalCost: round5(smsCost + llmCost),
  };
}
