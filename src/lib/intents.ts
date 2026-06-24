import { db } from "./supabase";
import { matchClients, createClient, updateClient } from "./clients";
import { createReminder, formatWhen, scheduleQuoteReminders, cancelQuoteReminders } from "./reminders";
import { answerQuery, ParseContext } from "./anthropic";
import { logLlm } from "./billing";
import { money, periodLabel, clientSummary, businessLang, t } from "./templates";
import { normalizeAmount, normalizePeriod, normalizeStatus, normalizeName, normalizeAddress, computeNextService, advanceService } from "./normalize";
import type { Business, Client, ParsedAction, ParseResult } from "./types";

/** Monthly-equivalent value of a client's recurring amount (0 for one-time). */
export function monthlyEquivalent(c: Pick<Client, "amount" | "billing_period">): number {
  if (c.amount == null) return 0;
  switch (c.billing_period) {
    case "monthly": return c.amount;
    case "weekly": return c.amount * 4.333;
    case "biweekly": return c.amount * (26 / 12);
    default: return 0; // one_time / unknown
  }
}

/**
 * Execute every action parsed from a message and return the combined SMS reply.
 * The reply always reflects the CLEAN normalized data, in the operator's language.
 */
export async function executeParsed(
  business: Business,
  result: ParseResult,
  ctx: ParseContext,
  sourceMessageId: string | null
): Promise<string> {
  const lang = businessLang(business);

  // The parser asked us to clarify rather than guess.
  if (result.needs_clarification) return result.needs_clarification;

  const replies: string[] = [];
  for (const action of result.actions) {
    replies.push(await runAction(business, action, ctx, sourceMessageId));
  }
  const out = replies.filter(Boolean).join("\n");
  return out || t.helpHint(lang);
}

async function runAction(business: Business, p: ParsedAction, ctx: ParseContext, sourceMessageId: string | null): Promise<string> {
  switch (p.intent) {
    case "log_quote": return logQuote(business, p, ctx);
    case "update_status": return updateStatus(business, p, ctx);
    case "log_job": return logJob(business, p);
    case "log_payment": return logPayment(business, p);
    case "set_reminder": return setReminder(business, p, sourceMessageId);
    case "correction": return applyCorrection(business, p);
    case "query": return runQuery(business, p, ctx);
    case "help":
    default: return t.helpHint(businessLang(business));
  }
}

/** Build a service-schedule patch (interval/day/next date) from a parsed action. */
function schedulePatch(p: ParsedAction, nowISO: string): Partial<Client> {
  if (!p.service_interval) return {};
  return {
    service_interval: p.service_interval,
    service_day: p.service_day ?? null,
    next_service_on: computeNextService(p.service_interval, p.service_day, nowISO) ?? null,
  };
}
function intervalWord(interval: string | null | undefined, lang: string): string {
  if (!interval) return "";
  const en: Record<string, string> = { weekly: "weekly", biweekly: "every other week", monthly: "monthly" };
  const es: Record<string, string> = { weekly: "semanal", biweekly: "cada dos semanas", monthly: "mensual" };
  return (lang === "es" ? es : en)[interval] ?? interval;
}
function fmtDay(ymd: string | null | undefined, lang: string): string {
  if (!ymd) return "";
  return new Date(ymd + "T00:00:00").toLocaleDateString(lang === "es" ? "es-ES" : "en-US", { month: "short", day: "numeric" });
}

async function logQuote(business: Business, p: ParsedAction, ctx: ParseContext): Promise<string> {
  const lang = businessLang(business);
  if (!p.client_name && !p.address) return t.whoIsQuoteFor(lang);
  const sched = schedulePatch(p, ctx.nowISO);

  const matches = await matchClients(business.id, { name: p.client_name, address: p.address });
  let client: Client;
  if (matches.length === 1) {
    client =
      (await updateClient(matches[0].id, {
        status: "quoted",
        address: p.address ?? matches[0].address,
        amount: p.amount ?? matches[0].amount,
        billing_period: p.billing_period ?? matches[0].billing_period,
        service_description: p.service_description ?? matches[0].service_description,
        last_nudged_at: null,
        ...sched,
      })) ?? matches[0];
  } else {
    client = await createClient(business.id, {
      name: p.client_name ?? p.address ?? "New client",
      address: p.address,
      amount: p.amount,
      billing_period: p.billing_period,
      service_description: p.service_description,
      status: "quoted",
      ...sched,
    });
  }

  await scheduleQuoteReminders(business, client);

  // Missing the price? Save what we have, then ask for it (don't store bad data).
  if (client.amount == null) return t.whatAmount(client.name, lang);
  return t.quoteLogged(clientSummary(client, lang), lang);
}

async function updateStatus(business: Business, p: ParsedAction, ctx: ParseContext): Promise<string> {
  const lang = businessLang(business);
  const sched = schedulePatch(p, ctx.nowISO);
  const hasSchedule = Object.keys(sched).length > 0;
  if (!p.status && !hasSchedule) return lang === "es" ? "¿Qué estado le pongo — activo, completado o perdido?" : "What status — active, completed, or lost?";
  if (!p.client_name && !p.address) return lang === "es" ? "¿Cuál cliente? Dime el nombre o la dirección." : "Which client? Tell me the name or address.";

  const matches = await matchClients(business.id, { name: p.client_name, address: p.address });
  if (matches.length === 0) return t.notFound(p.client_name ?? p.address ?? "", lang);
  if (matches.length > 1) {
    const opts = matches.slice(0, 4).map((c, i) => `(${i + 1}) ${c.name}${c.address ? ` — ${c.address}` : ""}`).join("  ");
    return t.whichClient(opts, lang);
  }
  const c = matches[0];
  const patch: Partial<Client> = { ...sched };
  if (p.status) patch.status = p.status;
  await updateClient(c.id, patch);
  if (p.status && p.status !== "quoted") await cancelQuoteReminders(c.id);
  if (p.status === "lost" || p.status === "completed") return t.clientRemoved(c.name, lang);

  // Schedule confirmation (e.g. "Bob — every other week, Tuesday · next Jun 30")
  if (hasSchedule) {
    const when = [
      intervalWord(p.service_interval, lang),
      p.service_day ? p.service_day.charAt(0).toUpperCase() + p.service_day.slice(1) : "",
    ].filter(Boolean).join(", ");
    const next = sched.next_service_on ? ` · ${lang === "es" ? "próximo" : "next"} ${fmtDay(sched.next_service_on, lang)}` : "";
    const verb = lang === "es" ? "Actualizado ✅" : "Updated ✅";
    return `${verb} ${c.name} — ${when}${next}.`;
  }
  return t.statusUpdated(c.name, p.status!, lang);
}

async function logJob(business: Business, p: ParsedAction): Promise<string> {
  const lang = businessLang(business);
  const matches = p.client_name || p.address ? await matchClients(business.id, { name: p.client_name, address: p.address }) : [];
  const client = matches.length === 1 ? matches[0] : null;
  const performedOn = p.performed_on ?? new Date().toISOString().slice(0, 10);
  await db().from("jobs").insert({
    business_id: business.id,
    client_id: client?.id ?? null,
    description: p.job_description ?? "Job",
    performed_on: performedOn,
  });
  // Advance the recurring schedule when a visit is logged.
  if (client?.service_interval && client.next_service_on) {
    const next = advanceService(client.next_service_on, client.service_interval as any);
    if (next) await updateClient(client.id, { next_service_on: next });
  }
  const who = client ? (lang === "es" ? `para ${client.name}` : `for ${client.name}`) : "";
  return t.jobLogged(p.job_description ?? "job", who, performedOn, lang).replace(/\s+/g, " ").trim();
}

async function logPayment(business: Business, p: ParsedAction): Promise<string> {
  const lang = businessLang(business);
  if (p.amount == null) return t.howMuchPayment(lang);
  const matches = p.client_name ? await matchClients(business.id, { name: p.client_name }) : [];
  const client = matches.length === 1 ? matches[0] : null;
  const status = p.payment_status ?? "paid";
  const paidOn = status === "paid" ? p.paid_on ?? new Date().toISOString().slice(0, 10) : null;
  await db().from("payments").insert({ business_id: business.id, client_id: client?.id ?? null, amount: p.amount, paid_on: paidOn, status });
  const who = client ? client.name : "";
  if (status === "unpaid" || status === "overdue") {
    const tag = status === "overdue" ? (lang === "es" ? " (atrasado)" : " (overdue)") : "";
    return lang === "es" ? `Anotado ✅ ${who} debe ${money(p.amount)}${tag}.` : `Noted ✅ ${who} owes ${money(p.amount)}${tag}.`;
  }
  const whoStr = client ? (lang === "es" ? ` de ${client.name}` : ` from ${client.name}`) : "";
  return t.paymentLogged(money(p.amount), whoStr, paidOn ?? "", lang);
}

async function setReminder(business: Business, p: ParsedAction, sourceMessageId: string | null): Promise<string> {
  const lang = businessLang(business);
  if (!p.due_at) return t.whenRemind(lang);
  const text = p.reminder_text || (lang === "es" ? "dar seguimiento" : "follow up");
  const matches = p.client_name ? await matchClients(business.id, { name: p.client_name }) : [];
  const client = matches.length === 1 ? matches[0] : null;
  await createReminder({ businessId: business.id, text, dueISO: p.due_at, clientId: client?.id ?? null, sourceMessageId, kind: "manual" });
  return t.reminderSet(formatWhen(p.due_at, business.timezone, lang), text, lang);
}

/** Apply a correction ("no it's 333 not 233", "change angela to weekly") to the last-touched client. */
async function applyCorrection(business: Business, p: ParsedAction): Promise<string> {
  const lang = businessLang(business);
  const { data: rows } = await db().from("clients").select("*").eq("business_id", business.id).order("updated_at", { ascending: false }).limit(1);
  const last = ((rows ?? []) as Client[])[0];
  if (!last) return lang === "es" ? "No hay nada que corregir todavía." : "Nothing to fix yet.";

  const text = p.correction_text ?? "";
  const patch: Partial<Client> = {};

  const period = normalizePeriod(text);
  if (period) patch.billing_period = period;
  const status = normalizeStatus(text);
  if (status) patch.status = status;

  // "it's A not B" / "A not B" -> A is the correct value.
  const notM = text.match(/([\d.,$kK]+)\s+not\s+[\d.,$kK]+/i) || text.match(/no es .* es ([\d.,$kK]+)/i);
  const amtToken = notM ? notM[1] : (text.match(/\$\s?[\d.,kK]+/) || [])[0];
  if (amtToken) {
    const n = normalizeAmount(amtToken);
    if (n != null) {
      // If the last client has an address and the token is a small whole number, it's likely a house number.
      if (last.address && /^\d{1,5}$/.test(amtToken.replace(/[^\d]/g, "")) && !/\$/.test(text) && !/(month|week|mo|wk|mes|semana)/i.test(text)) {
        patch.address = normalizeAddress(last.address.replace(/^\d+/, amtToken.replace(/[^\d]/g, "")));
      } else {
        patch.amount = n;
      }
    }
  }
  // "change <name> to ..." also lets us re-target, but we keep it on the last client for simplicity.
  const newName = text.match(/(?:name to|nombre a)\s+([a-zà-ÿ .'’-]+)/i);
  if (newName) patch.name = normalizeName(newName[1]);

  if (Object.keys(patch).length === 0) {
    return lang === "es" ? `¿Qué corrijo en ${last.name}?` : `What should I fix on ${last.name}?`;
  }
  const updated = (await updateClient(last.id, patch)) ?? last;
  return t.quoteLogged(clientSummary(updated, lang), lang);
}

async function runQuery(business: Business, p: ParsedAction, ctx: ParseContext): Promise<string> {
  const snapshot = await buildSnapshot(business);
  const { text, usage } = await answerQuery(p.query_text || "status", snapshot, ctx);
  await logLlm(business, "llm_query", usage);
  return text;
}

export async function buildSnapshot(business: Business): Promise<string> {
  const lang = businessLang(business);
  const { data: clientRows } = await db().from("clients").select("*").eq("business_id", business.id);
  const clients = (clientRows ?? []) as Client[];
  const quoted = clients.filter((c) => c.status === "quoted");
  const active = clients.filter((c) => c.status === "active");
  const mrr = active.reduce((sum, c) => sum + monthlyEquivalent(c), 0);

  const { data: reminderRows } = await db().from("reminders").select("*").eq("business_id", business.id).eq("status", "pending").order("due_at", { ascending: true });
  const { data: paymentRows } = await db().from("payments").select("*").eq("business_id", business.id).order("created_at", { ascending: false }).limit(20);
  const payments = (paymentRows ?? []) as { amount: number; status?: string; client_id: string | null; paid_on: string | null; created_at?: string }[];
  const outstanding = payments.filter((p) => p.status === "unpaid" || p.status === "overdue").reduce((s, p) => s + Number(p.amount), 0);

  const lines: string[] = [];
  lines.push(`OPEN QUOTES (need follow-up): ${quoted.length}`);
  for (const c of quoted) lines.push(`- ${c.name}${c.address ? ` (${c.address})` : ""}: ${money(c.amount)}${periodLabel(c.billing_period, lang)}${c.service_description ? `, ${c.service_description}` : ""}`);
  lines.push(`ACTIVE CLIENTS: ${active.length}`);
  for (const c of active) lines.push(`- ${c.name}: ${money(c.amount)}${periodLabel(c.billing_period, lang)}${c.service_description ? `, ${c.service_description}` : ""}${c.service_interval ? `, ${c.service_interval}${c.next_service_on ? ` (next ${c.next_service_on})` : ""}` : ""}`);
  lines.push(`MONTHLY RECURRING REVENUE (MRR): ${money(Math.round(mrr))}`);
  lines.push(`OUTSTANDING / UNPAID: ${money(outstanding)}`);
  lines.push(`UPCOMING REMINDERS: ${(reminderRows ?? []).length}`);
  for (const r of (reminderRows ?? []) as any[]) lines.push(`- ${r.text} (due ${formatWhen(r.due_at, business.timezone, lang)})`);
  lines.push(`RECENT PAYMENTS: ${(paymentRows ?? []).length}`);
  for (const r of (paymentRows ?? []) as any[]) lines.push(`- ${money(r.amount)} on ${r.paid_on ?? r.created_at?.slice(0, 10)}`);
  return lines.join("\n");
}
