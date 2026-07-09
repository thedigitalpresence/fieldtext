import { db } from "./supabase";
import { matchClients, matchClientsScored, createClient, updateClient, listClients, STRONG_MATCH } from "./clients";
import { createReminder, formatWhen, scheduleQuoteReminders, cancelQuoteReminders } from "./reminders";
import { answerQuery, ParseContext } from "./anthropic";
import { logLlm } from "./billing";
import { money, periodLabel, clientSummary, businessLang, t } from "./templates";
import {
  normalizeAmount, normalizePeriod, normalizeStatus, normalizeName, normalizeAddress,
  computeNextService, advanceService, todayInTz,
} from "./normalize";
import {
  generateDueCharges, createManualCharge, createJobCharge, applyPaymentToCharges,
  clientBalance, openBalances, totalOutstanding,
} from "./charges";
import { saveMedia } from "./attachments";
import { config } from "./config";
import type { Business, Client, Charge, Job, ParsedAction, ParseResult, PendingState, ServiceInterval, Lang } from "./types";

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

/** Conversation memory carried across one webhook execution; persisted by inbound.ts. */
export interface ActionSession {
  pending?: PendingState | null;
  lang?: Lang; // per-phone language override
}

const PENDING_TTL_MS = 15 * 60 * 1000;
function pendingExpiry(): string {
  return new Date(Date.now() + PENDING_TTL_MS).toISOString();
}

/**
 * Execute every action parsed from a message and return the combined SMS reply.
 * The reply always reflects the CLEAN normalized data, in the operator's language.
 * Each action is isolated: one failing action reports itself without killing the rest.
 */
export async function executeParsed(
  business: Business,
  result: ParseResult,
  ctx: ParseContext,
  sourceMessageId: string | null,
  session: ActionSession = {},
  rawText = ""
): Promise<string> {
  const lang = session.lang ?? businessLang(business);

  // The parser asked us to clarify rather than guess.
  if (result.needs_clarification) return result.needs_clarification;

  const replies: string[] = [];
  for (const action of result.actions) {
    try {
      replies.push(await runAction(business, action, ctx, sourceMessageId, session, lang, rawText));
    } catch (e) {
      console.error(`[intents] ${action.intent} failed:`, e);
      replies.push(t.errorSaving(lang));
    }
  }
  const out = replies.filter(Boolean).join("\n");
  return out || t.helpHint(lang);
}

async function runAction(
  business: Business, p: ParsedAction, ctx: ParseContext, sourceMessageId: string | null,
  session: ActionSession, lang: Lang, rawText: string
): Promise<string> {
  switch (p.intent) {
    case "log_quote": return logQuote(business, p, ctx, session, lang);
    case "update_status": return updateStatus(business, p, ctx, session, lang);
    case "log_job": return logJob(business, p, session, lang);
    case "log_payment": return logPayment(business, p, session, lang);
    case "set_reminder": return setReminder(business, p, sourceMessageId, lang);
    case "correction": return applyCorrection(business, p, lang);
    case "query": return runQuery(business, p, ctx);
    case "log_expense": return logExpense(business, p, lang);
    case "update_client_info": return updateClientInfo(business, p, session, lang);
    case "pause_client": return pauseClient(business, p, session, lang);
    case "resume_client": return resumeClient(business, p, session, lang);
    case "skip_visit": return skipVisit(business, p, session, lang);
    case "reschedule_visit": return rescheduleVisit(business, p, session, lang);
    case "bulk_reschedule": return bulkReschedule(business, p, lang);
    case "price_change": return priceChange(business, p, session, lang);
    case "request_invoice": return requestInvoice(business, p, session, lang);
    case "help":
    default:
      // Explicit "help" gets the menu; anything unparsed gets recovery copy.
      return /^\s*(help|ayuda|menu|menú)\s*$/i.test(rawText) || p.confidence >= 0.4
        ? t.helpHint(lang)
        : t.didntCatch(lang);
  }
}

// ── Client resolution with conversation memory ────────────────────────────────
/**
 * Resolve the client an action refers to. On ambiguity or no-match, stores a
 * pending question in the session (persisted per-phone) so the operator's NEXT
 * text ("2", "5 oak", "yes") completes the action instead of dead-ending.
 */
async function resolveClient(
  business: Business, p: ParsedAction, session: ActionSession, lang: Lang,
  opts: { offerCreate?: boolean } = {}
): Promise<{ client: Client | null; ask?: string }> {
  if (p.client_id) {
    const all = await listClients(business.id);
    const byId = all.find((c) => c.id === p.client_id) ?? null;
    if (byId) return { client: byId };
  }
  if (!p.client_name && !p.address) return { client: null };

  const matches = await matchClientsScored(business.id, { name: p.client_name, address: p.address });
  if (matches.length === 1) {
    // Strong match (exact/substring) -> use it. Weak match (shared last name,
    // typo bonus) -> CONFIRM: "Eric Shackelford" must never silently become
    // "Elena Shackelford".
    if (matches[0].score >= STRONG_MATCH || !p.client_name) return { client: matches[0].client };
    session.pending = { kind: "confirm_match", action: p, candidateIds: [matches[0].client.id], expiresAt: pendingExpiry() };
    return { client: null, ask: t.didYouMean(matches[0].client.name, p.client_name, lang) };
  }
  if (matches.length > 1) {
    const shown = matches.slice(0, 4);
    session.pending = { kind: "which_client", action: p, candidateIds: shown.map((m) => m.client.id), expiresAt: pendingExpiry() };
    const opts_ = shown.map((m, i) => `(${i + 1}) ${m.client.name}${m.client.address ? ` — ${m.client.address}` : ""}`).join("  ");
    return { client: null, ask: t.whichClient(opts_, lang) };
  }
  // No match.
  if (opts.offerCreate && p.client_name) {
    session.pending = { kind: "confirm_create", action: p, expiresAt: pendingExpiry() };
    return { client: null, ask: t.yesToAdd(p.client_name, lang) };
  }
  return { client: null, ask: t.notFound(p.client_name ?? p.address ?? "", lang) };
}

/** Resume a stored pending action with the operator's answer. Exported for inbound.ts. */
export async function resolvePending(
  business: Business, pending: PendingState, answer: string, ctx: ParseContext, session: ActionSession
): Promise<string | null> {
  const lang = session.lang ?? businessLang(business);
  if (new Date(pending.expiresAt).getTime() < Date.now()) return null;
  const a = answer.trim();

  if (pending.kind === "which_client") {
    const ids = pending.candidateIds ?? [];
    let chosen: string | null = null;
    const numM = a.match(/^\(?\s*([1-4])\s*\)?\.?$/);
    if (numM) chosen = ids[Number(numM[1]) - 1] ?? null;
    if (!chosen) {
      // Try the answer as a name/address against the candidates only.
      const all = await listClients(business.id);
      const cands = all.filter((c) => ids.includes(c.id));
      const norm = a.toLowerCase();
      const hit = cands.filter((c) => c.name.toLowerCase().includes(norm) || (c.address ?? "").toLowerCase().includes(norm));
      if (hit.length === 1) chosen = hit[0].id;
    }
    if (!chosen) return null; // unrelated text — fall through to a normal parse
    const action: ParsedAction = { ...pending.action, client_id: chosen };
    return runAction(business, action, ctx, null, session, lang, a);
  }

  // "Whose site is this photo from?" — the reply names the client.
  if (pending.kind === "attach_photo") {
    if (/^\s*(import|importar)\s*[.!]?\s*$/i.test(a)) return t.photoHint(lang);
    const matches = await matchClientsScored(business.id, { name: a });
    if (matches.length === 1 && matches[0].score >= STRONG_MATCH) {
      const client = matches[0].client;
      const saved = await saveMedia(business.id, client.id, pending.media ?? [], pending.action.note_text ?? null);
      return saved > 0 ? t.photoSaved(saved, client.name, lang) : t.errorSaving(lang);
    }
    if (matches.length > 1) {
      session.pending = pending; // keep the photo waiting; a more specific name resolves it
      const opts = matches.slice(0, 4).map((m, i) => `(${i + 1}) ${m.client.name}${m.client.address ? ` — ${m.client.address}` : ""}`).join("  ");
      return t.whichClient(opts, lang);
    }
    if (/^[a-zà-ÿ][a-zà-ÿ .'’-]{2,}$/i.test(a.trim())) {
      // Unknown name — keep the photo waiting and say so.
      session.pending = pending;
      return t.notFound(a.trim(), lang);
    }
    return null; // unrelated text — normal parse takes over, photo expires
  }

  if (pending.kind === "confirm_match") {
    const candidateId = pending.candidateIds?.[0];
    if (/^\s*(yes|yeah|yep|s[ií]|dale|ok)\s*[.!]?\s*$/i.test(a) && candidateId) {
      const action: ParsedAction = { ...pending.action, client_id: candidateId };
      return runAction(business, action, ctx, null, session, lang, a);
    }
    if (/^\s*(new|nuevo|no|nope)\s*[.!]?\s*$/i.test(a)) {
      const p = pending.action;
      const client = await createClient(business.id, {
        name: p.client_name ?? "New client",
        address: p.address,
        // Quotes stay quoted (unless won); note-first prospects start quoted too
        // (a site visit before any deal); everything else implies won work.
        status: p.intent === "log_quote"
          ? (p.status === "active" ? "active" : "quoted")
          : p.intent === "update_client_info" ? "quoted" : "active",
      });
      const action: ParsedAction = { ...p, client_id: client.id, client_is_new: true };
      return runAction(business, action, ctx, null, session, lang, a);
    }
    return null; // unrelated text — parse normally
  }

  if (pending.kind === "confirm_create") {
    if (/^\s*(yes|yeah|yep|s[ií]|dale|ok)\s*[.!]?\s*$/i.test(a)) {
      const p = pending.action;
      const client = await createClient(business.id, {
        name: p.client_name ?? "New client",
        address: p.address,
        // Quotes stay quoted (unless won); note-first prospects start quoted too
        // (a site visit before any deal); everything else implies won work.
        status: p.intent === "log_quote"
          ? (p.status === "active" ? "active" : "quoted")
          : p.intent === "update_client_info" ? "quoted" : "active",
      });
      const action: ParsedAction = { ...p, client_id: client.id, client_is_new: true };
      return runAction(business, action, ctx, null, session, lang, a);
    }
    if (/^\s*(no|nah|nope)\s*[.!]?\s*$/i.test(a)) {
      return lang === "es" ? "Ok, no lo agregué." : "Ok, didn't add them.";
    }
    return null;
  }

  if (pending.kind === "missing_amount") {
    const n = normalizeAmount(a);
    if (n == null) return null;
    const action: ParsedAction = { ...pending.action, amount: n };
    return runAction(business, action, ctx, null, session, lang, a);
  }

  // Completing a new client: pull phone / address / full name out of one reply.
  if (pending.kind === "complete_client") {
    const clientId = pending.action.client_id;
    if (!clientId) return null;
    const missing = pending.missing ?? [];
    const patch: Partial<Client> = {};
    let rest = a;

    const phoneM = rest.match(/(\+?1?[\s\-.(]*\d{3}[)\s\-.]*\d{3}[\s\-.]*\d{4})/);
    if (phoneM && missing.includes("phone")) {
      patch.phone = phoneM[1].replace(/[^\d+]/g, "").replace(/^1(?=\d{10}$)/, "+1").replace(/^(?=\d{10}$)/, "+1");
      rest = rest.replace(phoneM[1], " ").trim();
    }
    rest = rest.replace(/^[,;·-]+|[,;·-]+$/g, "").trim();
    if (rest) {
      if (missing.includes("address") && /\d/.test(rest)) {
        patch.address = normalizeAddress(rest);
      } else if (missing.includes("name") && !/\d/.test(rest) && rest.split(/\s+/).length <= 4) {
        patch.name = normalizeName(rest);
      } else if (missing.includes("address") && !missing.includes("service")) {
        patch.address = normalizeAddress(rest); // street without a number still counts
      } else if (missing.includes("service")) {
        patch.service_description = rest.toLowerCase();
      } else if (missing.includes("address")) {
        patch.address = normalizeAddress(rest);
      }
    }
    if (!Object.keys(patch).length) return null; // unrelated text — parse normally

    const all = await listClients(business.id);
    const before = all.find((c) => c.id === clientId);
    if (!before) return null;
    const client = (await updateClient(clientId, patch)) ?? before;

    const stillMissing = missing.filter((m) =>
      m === "phone" ? !client.phone
      : m === "address" ? !client.address
      : m === "service" ? !client.service_description
      : client.name.trim().split(/\s+/).length < 2
    );
    const savedBits = [
      patch.name ? client.name : null,
      patch.address ? client.address : null,
      patch.phone ? `📞 ${client.phone}` : null,
      patch.service_description ? client.service_description : null,
    ].filter(Boolean).join(" · ");
    if (stillMissing.length) {
      session.pending = { kind: "complete_client", action: pending.action, missing: stillMissing, expiresAt: pendingExpiry() };
      return `${t.infoSaved(client.name, savedBits, lang)} ${t.needInfo(client.name, stillMissing, lang)}`;
    }
    return t.infoSaved(client.name, savedBits, lang);
  }
  return null;
}

// ── Shared helpers ────────────────────────────────────────────────────────────
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

// ── Handlers ──────────────────────────────────────────────────────────────────
async function logQuote(business: Business, p: ParsedAction, ctx: ParseContext, session: ActionSession, lang: Lang): Promise<string> {
  if (!p.client_name && !p.address && !p.client_id) return t.whoIsQuoteFor(lang);
  const sched = schedulePatch(p, ctx.nowISO);

  let client: Client | null = null;
  if (p.client_id) {
    const all = await listClients(business.id);
    client = all.find((c) => c.id === p.client_id) ?? null;
  } else {
    const matches = await matchClientsScored(business.id, { name: p.client_name, address: p.address });
    if (matches.length > 1) {
      const shown = matches.slice(0, 4);
      session.pending = { kind: "which_client", action: p, candidateIds: shown.map((m) => m.client.id), expiresAt: pendingExpiry() };
      const opts = shown.map((m, i) => `(${i + 1}) ${m.client.name}${m.client.address ? ` — ${m.client.address}` : ""}`).join("  ");
      return t.whichClient(opts, lang);
    }
    if (matches.length === 1 && matches[0].score < STRONG_MATCH && p.client_name) {
      // Weak lookalike (e.g. same last name only): confirm before touching either record.
      session.pending = { kind: "confirm_match", action: p, candidateIds: [matches[0].client.id], expiresAt: pendingExpiry() };
      return t.didYouMean(matches[0].client.name, p.client_name, lang);
    }
    client = matches[0]?.client ?? null;
  }

  // Guard: a new price for an EXISTING active client is a price update, not a
  // re-quote. (Demoting them would drop MRR and restart follow-up nudges.)
  // A client we just created via conversation memory is initial setup, not a change.
  if (client && client.status === "active" && p.amount != null && !p.client_is_new) {
    const updated = (await updateClient(client.id, {
      amount: p.amount,
      billing_period: p.billing_period ?? client.billing_period,
      service_description: p.service_description ?? client.service_description,
      ...sched,
    })) ?? client;
    return t.priceChanged(updated.name, `${money(p.amount)}${periodLabel(updated.billing_period, lang)}`, lang);
  }

  // "new job <name>..." = already-won work: the client starts ACTIVE and gets no
  // quote-followup nudges. Only an actual quote starts as quoted.
  const targetStatus = p.status === "active" ? "active" : "quoted";
  let isNew = Boolean(p.client_is_new);
  if (client) {
    client =
      (await updateClient(client.id, {
        status: targetStatus,
        address: p.address ?? client.address,
        amount: p.amount ?? client.amount,
        billing_period: p.billing_period ?? client.billing_period,
        service_description: p.service_description ?? client.service_description,
        last_nudged_at: null,
        ...sched,
      })) ?? client;
  } else {
    isNew = true;
    client = await createClient(business.id, {
      name: p.client_name ?? p.address ?? "New client",
      address: p.address,
      amount: p.amount,
      billing_period: p.billing_period,
      service_description: p.service_description,
      status: targetStatus,
      ...sched,
    });
  }

  if (targetStatus === "quoted") await scheduleQuoteReminders(business, client);
  else await cancelQuoteReminders(client.id);

  // Missing the price? Save what we have, remember the question, ask for it.
  // (client_is_new keeps the completeness chase alive after the price arrives.)
  if (client.amount == null) {
    session.pending = { kind: "missing_amount", action: { ...p, client_id: client.id, client_is_new: isNew }, expiresAt: pendingExpiry() };
    return t.whatAmount(client.name, lang);
  }

  // Mandatory profile for a NEW client: full name, address, phone, service.
  // Save what we have, then chase what's missing in one question.
  const confirmation = t.quoteLogged(clientSummary(client, lang), lang);
  if (isNew) {
    const missing: string[] = [];
    if (client.name.trim().split(/\s+/).length < 2) missing.push("name");
    if (!client.address) missing.push("address");
    if (!client.phone) missing.push("phone");
    if (!client.service_description) missing.push("service");
    if (missing.length) {
      session.pending = { kind: "complete_client", action: { ...p, client_id: client.id }, missing, expiresAt: pendingExpiry() };
      return `${confirmation}\n${t.needInfo(client.name, missing, lang)}`;
    }
  }
  return confirmation;
}

async function updateStatus(business: Business, p: ParsedAction, ctx: ParseContext, session: ActionSession, lang: Lang): Promise<string> {
  const sched = schedulePatch(p, ctx.nowISO);
  const hasSchedule = Object.keys(sched).length > 0;
  if (!p.status && !hasSchedule) return lang === "es" ? "¿Qué estado le pongo — activo, completado o perdido?" : "What status — active, completed, or lost?";
  if (!p.client_name && !p.address && !p.client_id) return lang === "es" ? "¿Cuál cliente? Dime el nombre o la dirección." : "Which client? Tell me the name or address.";

  const { client: c, ask } = await resolveClient(business, p, session, lang);
  if (!c) return ask ?? t.notFound(p.client_name ?? p.address ?? "", lang);

  const patch: Partial<Client> = { ...sched };
  if (p.status) patch.status = p.status;
  await updateClient(c.id, patch);
  if (p.status && p.status !== "quoted") await cancelQuoteReminders(c.id);
  if (p.status === "completed") return t.clientCompleted(c.name, lang);
  if (p.status === "lost") return t.clientLost(c.name, lang);

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

async function logJob(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const today = todayInTz(business.timezone);
  const hasClientRef = Boolean(p.client_name || p.address || p.client_id);
  let client: Client | null = null;
  if (hasClientRef) {
    const { client: c, ask } = await resolveClient(business, p, session, lang, { offerCreate: true });
    if (!c && ask) return ask; // ambiguous or unknown — ask instead of orphaning the job
    client = c;
  }

  // Future one-off ("mulch at the smiths next tuesday $450") → scheduled job.
  if (p.scheduled_on && p.scheduled_on > today) {
    await db().from("jobs").insert({
      business_id: business.id,
      client_id: client?.id ?? null,
      description: p.job_description ?? "Job",
      performed_on: null,
      scheduled_on: p.scheduled_on,
      amount: p.amount ?? null,
      status: "scheduled",
    });
    return t.jobScheduled(
      p.job_description ?? "job",
      client?.name ?? (lang === "es" ? "cliente" : "client"),
      fmtDay(p.scheduled_on, lang),
      p.amount != null ? money(p.amount) : null,
      lang
    );
  }

  const performedOn = p.performed_on ?? today;
  await db().from("jobs").insert({
    business_id: business.id,
    client_id: client?.id ?? null,
    description: p.job_description ?? "Job",
    performed_on: performedOn,
    status: "done",
    amount: p.amount ?? null,
  });

  // A priced one-off done = money now owed.
  if (client && p.amount != null) {
    await createJobCharge(business.id, client.id, p.amount, performedOn, p.job_description ?? null);
  }

  // Advance the recurring schedule — from whichever is later, the stored next
  // date or the visit itself, so an overdue client doesn't stay overdue forever.
  let nextStr = "";
  if (client?.service_interval) {
    const base = client.next_service_on && client.next_service_on > performedOn ? client.next_service_on : performedOn;
    const next = advanceService(base, client.service_interval as ServiceInterval);
    if (next) {
      await updateClient(client.id, { next_service_on: next });
      nextStr = t.jobNextVisit(fmtDay(next, lang), lang);
    }
  }
  const who = client ? (lang === "es" ? `para ${client.name}` : `for ${client.name}`) : "";
  const base = t.jobLogged(p.job_description ?? "job", who, fmtDay(performedOn, lang), lang).replace(/\s+/g, " ").trim();
  return base + nextStr;
}

async function logPayment(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  if (p.amount == null) {
    session.pending = { kind: "missing_amount", action: p, expiresAt: pendingExpiry() };
    return t.howMuchPayment(lang);
  }
  const hasClientRef = Boolean(p.client_name || p.client_id);
  let client: Client | null = null;
  if (hasClientRef) {
    const { client: c, ask } = await resolveClient(business, p, session, lang, { offerCreate: true });
    if (!c && ask) return ask; // never silently attach money to nobody
    client = c;
  }

  const today = todayInTz(business.timezone);
  const status = p.payment_status ?? "paid";

  // "bob owes 450" → a receivable, not a payment.
  if (status === "unpaid" || status === "overdue") {
    await createManualCharge(business.id, client?.id ?? null, p.amount, today, p.job_description ?? null);
    const who = client ? client.name : "";
    const balance = client ? await clientBalance(business.id, client.id) : p.amount;
    const tag = status === "overdue" ? (lang === "es" ? " (atrasado)" : " (overdue)") : "";
    const total = balance > p.amount + 0.004 ? (lang === "es" ? ` Total pendiente: ${money(balance)}.` : ` Total owed: ${money(balance)}.`) : "";
    return (lang === "es" ? `Anotado ✅ ${who} debe ${money(p.amount)}${tag}.` : `Noted ✅ ${who} owes ${money(p.amount)}${tag}.`) + total;
  }

  // Money in: record it and settle open charges oldest-first.
  const paidOn = p.paid_on ?? today;
  await db().from("payments").insert({
    business_id: business.id, client_id: client?.id ?? null, amount: p.amount,
    paid_on: paidOn, status: "paid", method: p.payment_method ?? null,
  });

  const whoStr = client ? (lang === "es" ? ` de ${client.name}` : ` from ${client.name}`) : "";
  let base = t.paymentLogged(money(p.amount), whoStr, fmtDay(paidOn, lang), lang);
  if (client) {
    const balance = await applyPaymentToCharges(business.id, client.id, p.amount);
    base += balance > 0.004 ? t.balanceRemaining(client.name, money(balance), lang) : t.allSettled(client.name, lang);
  } else if (p.client_name) {
    // resolveClient already asked; unreachable — kept for safety.
  } else {
    base += t.paymentUnlinked(lang);
  }
  return base;
}

async function setReminder(business: Business, p: ParsedAction, sourceMessageId: string | null, lang: Lang): Promise<string> {
  if (!p.due_at) return t.whenRemind(lang);
  const text = p.reminder_text || (lang === "es" ? "dar seguimiento" : "follow up");
  const matches = p.client_name ? await matchClients(business.id, { name: p.client_name }) : [];
  const client = matches.length === 1 ? matches[0] : null;
  await createReminder({ businessId: business.id, text, dueISO: p.due_at, clientId: client?.id ?? null, sourceMessageId, kind: "manual" });
  return t.reminderSet(formatWhen(p.due_at, business.timezone, lang), text, lang);
}

/** Apply a correction ("no it's 333 not 233", "change angela to weekly") to the last-touched client. */
async function applyCorrection(business: Business, p: ParsedAction, lang: Lang): Promise<string> {
  const { data: rows } = await db().from("clients").select("*").eq("business_id", business.id).order("updated_at", { ascending: false }).limit(1);
  const last = ((rows ?? []) as Client[])[0];
  if (!last) return lang === "es" ? "No hay nada que corregir todavía." : "Nothing to fix yet.";

  const text = p.correction_text ?? "";
  const patch: Partial<Client> = {};

  const period = normalizePeriod(text);
  if (period) patch.billing_period = period;
  const status = normalizeStatus(text);
  if (status) patch.status = status;

  const notM = text.match(/([\d.,$kK]+)\s+not\s+[\d.,$kK]+/i) || text.match(/no es .* es ([\d.,$kK]+)/i);
  const amtToken = notM ? notM[1] : (text.match(/\$\s?[\d.,kK]+/) || [])[0];
  if (amtToken) {
    const n = normalizeAmount(amtToken);
    if (n != null) {
      if (last.address && /^\d{1,5}$/.test(amtToken.replace(/[^\d]/g, "")) && !/\$/.test(text) && !/(month|week|mo|wk|mes|semana)/i.test(text)) {
        patch.address = normalizeAddress(last.address.replace(/^\d+/, amtToken.replace(/[^\d]/g, "")));
      } else {
        patch.amount = n;
      }
    }
  }
  const newName = text.match(/(?:name to|nombre a)\s+([a-zà-ÿ .'’-]+)/i);
  if (newName) patch.name = normalizeName(newName[1]);

  if (Object.keys(patch).length === 0) {
    return lang === "es" ? `¿Qué corrijo en ${last.name}?` : `What should I fix on ${last.name}?`;
  }
  const updated = (await updateClient(last.id, patch)) ?? last;
  return t.quoteLogged(clientSummary(updated, lang), lang);
}

// ── New roadmap handlers ──────────────────────────────────────────────────────
async function logExpense(business: Business, p: ParsedAction, lang: Lang): Promise<string> {
  if (p.amount == null) return lang === "es" ? "¿De cuánto fue el gasto?" : "How much was the expense?";
  const today = todayInTz(business.timezone);
  const category = p.expense_category ?? "other";
  const description = p.note_text ?? p.job_description ?? null;
  await db().from("expenses").insert({
    business_id: business.id, amount: p.amount, category, description, spent_on: p.performed_on ?? today,
  });
  return t.expenseLogged(money(p.amount), category, description ?? "", lang);
}

async function updateClientInfo(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang, { offerCreate: true });
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);

  const patch: Partial<Client> = {};
  const saved: string[] = [];
  if (p.phone) { patch.phone = p.phone; saved.push(`📞 ${p.phone}`); }
  if (p.email) { patch.email = p.email; saved.push(`✉️ ${p.email}`); }
  if (p.referred_by) { patch.referred_by = p.referred_by; saved.push(lang === "es" ? `referido por ${p.referred_by}` : `referred by ${p.referred_by}`); }
  if (p.note_text) {
    patch.notes = client.notes ? `${client.notes}\n${p.note_text}` : p.note_text;
    saved.push(lang === "es" ? `nota: "${p.note_text}"` : `note: "${p.note_text}"`);
  }
  if (!saved.length) return lang === "es" ? `¿Qué guardo para ${client.name}?` : `What should I save for ${client.name}?`;
  await updateClient(client.id, patch);
  return t.infoSaved(client.name, saved.join(" · "), lang);
}

async function pauseClient(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  await updateClient(client.id, { status: "paused", paused_until: p.pause_until ?? null, next_service_on: null });
  await cancelQuoteReminders(client.id);
  if (p.pause_until) {
    const resumeText = lang === "es" ? `Reanudar servicio de ${client.name}?` : `Resume service for ${client.name}?`;
    await createReminder({
      businessId: business.id, clientId: client.id, text: resumeText,
      dueISO: new Date(p.pause_until + "T13:00:00Z").toISOString(), kind: "manual",
    });
  }
  return t.clientPaused(client.name, p.pause_until ? fmtDay(p.pause_until, lang) : null, lang);
}

async function resumeClient(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  const next = client.service_interval
    ? computeNextService(client.service_interval as ServiceInterval, client.service_day, new Date().toISOString())
    : null;
  await updateClient(client.id, { status: "active", paused_until: null, next_service_on: next ?? null });
  return t.clientResumed(client.name, next ? fmtDay(next, lang) : null, lang);
}

async function skipVisit(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  const interval = (client.service_interval as ServiceInterval) ?? "weekly";
  const base = client.next_service_on ?? todayInTz(business.timezone);
  const next = advanceService(base, interval);
  if (!next) return lang === "es" ? `${client.name} no tiene visitas programadas.` : `${client.name} has no scheduled visits.`;
  await updateClient(client.id, { next_service_on: next });
  return t.visitSkipped(client.name, fmtDay(next, lang), lang);
}

async function rescheduleVisit(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  if (!p.target_date) return lang === "es" ? `¿Para cuándo muevo a ${client.name}?` : `When should I move ${client.name} to?`;
  await updateClient(client.id, { next_service_on: p.target_date });
  return t.visitMoved(client.name, fmtDay(p.target_date, lang), lang);
}

/** "rained out, push today to tomorrow" — shift every stop due (or overdue) today. */
async function bulkReschedule(business: Business, p: ParsedAction, lang: Lang): Promise<string> {
  const today = todayInTz(business.timezone);
  // Default target: tomorrow in the business timezone.
  const target = p.target_date && p.target_date > today
    ? p.target_date
    : new Date(new Date(today + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);

  const { data: rows } = await db().from("clients").select("*").eq("business_id", business.id).eq("status", "active");
  const due = ((rows ?? []) as Client[]).filter((c) => c.next_service_on && c.next_service_on <= today);
  if (!due.length) return t.nothingDueToday(lang);
  for (const c of due) await updateClient(c.id, { next_service_on: target });
  const names = due.slice(0, 8).map((c) => c.name).join(", ") + (due.length > 8 ? "…" : "");
  return t.bulkMoved(names, fmtDay(target, lang), due.length, lang);
}

async function priceChange(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  if (p.amount == null) {
    session.pending = { kind: "missing_amount", action: { ...p, client_id: client.id }, expiresAt: pendingExpiry() };
    return lang === "es" ? `¿Cuál es el nuevo precio para ${client.name}?` : `What's the new price for ${client.name}?`;
  }
  const updated = (await updateClient(client.id, {
    amount: p.amount,
    billing_period: p.billing_period ?? client.billing_period,
  })) ?? client;
  return t.priceChanged(updated.name, `${money(p.amount)}${periodLabel(updated.billing_period, lang)}`, lang);
}

/** "invoice bob" / "receipt bob" → a forwardable link (FieldText never texts the customer). */
async function requestInvoice(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  const kind = p.invoice_kind ?? "invoice";
  const today = todayInTz(business.timezone);

  let lines: { description: string; amount: number; due_on?: string }[] = [];
  if (kind === "invoice") {
    const { data: rows } = await db()
      .from("charges").select("*")
      .eq("business_id", business.id).eq("client_id", client.id)
      .in("status", ["open", "partial"])
      .order("due_on", { ascending: true });
    lines = ((rows ?? []) as Charge[]).map((ch) => ({
      description: ch.description || (lang === "es" ? "Servicio" : "Service"),
      amount: Number(ch.amount) - Number(ch.paid_amount),
      due_on: ch.due_on,
    })).filter((l) => l.amount > 0.004);
    if (!lines.length) return t.noOpenBalance(client.name, lang);
  } else {
    const { data: rows } = await db()
      .from("payments").select("*")
      .eq("business_id", business.id).eq("client_id", client.id)
      .order("created_at", { ascending: false }).limit(1);
    const last = ((rows ?? []) as { amount: number; paid_on: string | null }[])[0];
    if (!last) return lang === "es" ? `No hay pagos registrados de ${client.name}.` : `No payments on file for ${client.name}.`;
    lines = [{ description: lang === "es" ? "Pago recibido" : "Payment received", amount: Number(last.amount), due_on: last.paid_on ?? today }];
  }

  const total = lines.reduce((s, l) => s + l.amount, 0);
  const { data: inv, error } = await db().from("invoices").insert({
    business_id: business.id,
    client_id: client.id,
    kind,
    payload: {
      business_name: business.name,
      client_name: client.name,
      client_address: client.address,
      lines, total,
      payment_note: business.settings?.payment_note ?? null,
      lang,
      date: today,
    },
  }).select("*").single();
  if (error || !inv) throw new Error(`invoice create failed: ${error?.message}`);

  const url = `${config.appUrl()}/i/${(inv as { id: string }).id}`;
  return kind === "invoice"
    ? t.invoiceLink(client.name, money(total), url, lang)
    : t.receiptLink(client.name, money(total), url, lang);
}

async function runQuery(business: Business, p: ParsedAction, ctx: ParseContext): Promise<string> {
  const snapshot = await buildSnapshot(business);
  const { text, usage } = await answerQuery(p.query_text || "status", snapshot, ctx);
  await logLlm(business, "llm_query", usage);
  return text;
}

// ── Query snapshot: everything the operator actually asks about ──────────────
export async function buildSnapshot(business: Business): Promise<string> {
  const lang = businessLang(business);
  const today = todayInTz(business.timezone);
  const monthStart = today.slice(0, 7) + "-01";

  const { data: clientRows } = await db().from("clients").select("*").eq("business_id", business.id);
  const clients = (clientRows ?? []) as Client[];
  const nameOf = (id: string | null) => clients.find((c) => c.id === id)?.name ?? "(no client)";
  const quoted = clients.filter((c) => c.status === "quoted");
  const active = clients.filter((c) => c.status === "active");
  const paused = clients.filter((c) => c.status === "paused");
  const mrr = active.reduce((sum, c) => sum + monthlyEquivalent(c), 0);

  const [{ data: reminderRows }, { data: paymentRows }, { data: jobRows }, balances] = await Promise.all([
    db().from("reminders").select("*").eq("business_id", business.id).eq("status", "pending").order("due_at", { ascending: true }),
    db().from("payments").select("*").eq("business_id", business.id).order("created_at", { ascending: false }).limit(20),
    db().from("jobs").select("*").eq("business_id", business.id).order("performed_on", { ascending: false }).limit(15),
    openBalances(business.id),
  ]);

  const payments = (paymentRows ?? []) as { amount: number; client_id: string | null; paid_on: string | null; created_at?: string; method?: string | null }[];
  const mtd = payments
    .filter((p) => (p.paid_on ?? p.created_at?.slice(0, 10) ?? "") >= monthStart)
    .reduce((s, p) => s + Number(p.amount), 0);

  const lines: string[] = [];
  lines.push(`TODAY: ${today}`);
  const noteStr = (c: Client) => (c.notes ? `, notes: "${c.notes.replace(/\n/g, "; ").slice(0, 120)}"` : "");
  lines.push(`OPEN QUOTES & PROSPECTS (need follow-up): ${quoted.length}`);
  for (const c of quoted) lines.push(`- ${c.name}${c.address ? ` (${c.address})` : ""}: ${money(c.amount)}${periodLabel(c.billing_period, lang)}${c.service_description ? `, ${c.service_description}` : ""}${noteStr(c)}`);
  lines.push(`ACTIVE CLIENTS: ${active.length}`);
  for (const c of active) lines.push(`- ${c.name}${c.address ? ` (${c.address})` : ""}: ${money(c.amount)}${periodLabel(c.billing_period, lang)}${c.service_description ? `, ${c.service_description}` : ""}${c.phone ? `, ph ${c.phone}` : ""}${c.service_day ? `, ${c.service_day}s` : ""}${c.next_service_on ? ` (next visit ${c.next_service_on})` : ""}${noteStr(c)}`);
  if (paused.length) {
    lines.push(`PAUSED CLIENTS: ${paused.length}`);
    for (const c of paused) lines.push(`- ${c.name}${c.paused_until ? ` (until ${c.paused_until})` : ""}`);
  }

  // Route by weekday — answers "what's my monday look like?"
  const byDay = new Map<string, string[]>();
  for (const c of active) {
    if (!c.service_day) continue;
    byDay.set(c.service_day, [...(byDay.get(c.service_day) ?? []), `${c.name}${c.address ? ` (${c.address})` : ""}`]);
  }
  if (byDay.size) {
    lines.push(`ROUTE BY DAY:`);
    for (const [day, names] of byDay) lines.push(`- ${day}: ${names.join(", ")}`);
  }

  lines.push(`MONTHLY RECURRING REVENUE (MRR): ${money(Math.round(mrr))}`);
  lines.push(`COLLECTED THIS MONTH: ${money(mtd)}`);
  lines.push(`WHO OWES (open balances): ${balances.length ? "" : "nobody"}`);
  for (const b of balances) lines.push(`- ${nameOf(b.client_id)}: ${money(b.balance)} (oldest due ${b.oldest_due})`);
  lines.push(`UPCOMING REMINDERS: ${(reminderRows ?? []).length}`);
  for (const r of (reminderRows ?? []) as { text: string; due_at: string }[]) lines.push(`- ${r.text} (due ${formatWhen(r.due_at, business.timezone, lang)})`);
  lines.push(`RECENT PAYMENTS (newest first):`);
  for (const r of payments) lines.push(`- ${money(r.amount)} from ${nameOf(r.client_id)} on ${r.paid_on ?? r.created_at?.slice(0, 10)}${r.method ? ` (${r.method})` : ""}`);
  lines.push(`RECENT JOBS (newest first):`);
  for (const j of (jobRows ?? []) as Job[]) lines.push(`- ${j.description} for ${nameOf(j.client_id)} on ${j.performed_on ?? j.scheduled_on}${j.status === "scheduled" ? " (scheduled)" : ""}`);
  return lines.join("\n");
}

export { generateDueCharges, totalOutstanding, openBalances };
