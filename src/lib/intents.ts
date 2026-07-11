import { db } from "./supabase";
import { matchClients, matchClientsScored, createClient, updateClient, listClients, findClientInPhrase, STRONG_MATCH } from "./clients";
import { createReminder, formatWhen, scheduleQuoteReminders, cancelQuoteReminders } from "./reminders";
import { answerQuery, heuristicParse, ParseContext } from "./anthropic";
import { logLlm } from "./billing";
import { money, periodLabel, clientSummary, businessLang, t } from "./templates";
import {
  normalizeAmount, normalizePeriod, normalizeStatus, normalizeName, normalizeAddress,
  computeNextService, advanceService, todayInTz, normalizeWeekday, resolveDate,
} from "./normalize";
import {
  generateDueCharges, createManualCharge, createJobCharge, applyPaymentToCharges,
  clientBalance, openBalances, totalOutstanding,
} from "./charges";
import { saveMedia } from "./attachments";
import { toE164 } from "./phone";
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

// 6 hours: an operator working between houses answers a question long after we
// asked it. 15 min was the top cause of "I answered but it forgot" reports.
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
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

  // Trust scale: if the parse is shaky or self-contradictory, ASK instead of
  // firing actions we're not sure about (e.g. "add Mitch to reminder quote now").
  if (looksAmbiguous(result)) return t.notSure(rawText, lang);

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

/**
 * The "trust scale": decide whether a parse is too shaky to act on. We ask for
 * clarification when nothing is confident, when a short message was split into
 * conflicting actions, or when a bare "add X <field>" (no value) is mixed with
 * other actions (a tell-tale sign the message was misparsed). Pure query/help
 * parses are never gated — they have their own soft handling.
 */
export function looksAmbiguous(result: ParseResult): boolean {
  const acts = result.actions ?? [];
  if (!acts.length) return false;
  const intents = new Set(acts.map((a) => a.intent));
  if ([...intents].every((i) => i === "query" || i === "help")) return false;
  const confs = acts.map((a) => a.confidence ?? 0);
  const top = Math.max(...confs);
  const min = Math.min(...confs);
  const bareCollectWithOthers = acts.length > 1 && acts.some((a) => a.intent === "update_client_info" && a.collect_field);
  return top < 0.5 || bareCollectWithOthers || (acts.length > 1 && intents.size > 1 && min < 0.55);
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
    case "log_expense": return logExpense(business, p, session, lang);
    case "update_client_info": return updateClientInfo(business, p, session, lang);
    case "pause_client": return pauseClient(business, p, session, lang);
    case "resume_client": return resumeClient(business, p, session, lang);
    case "skip_visit": return skipVisit(business, p, session, lang);
    case "reschedule_visit": return rescheduleVisit(business, p, session, lang);
    case "bulk_reschedule": return bulkReschedule(business, p, lang);
    case "price_change": return priceChange(business, p, session, lang);
    case "request_invoice": return requestInvoice(business, p, session, lang);
    case "help":
    default: {
      const rt = rawText.trim();
      // Explicit help/menu → the menu.
      if (/^\s*(help|ayuda|menu|menú)\s*$/i.test(rt)) return t.helpHint(lang);
      // A real question or conversational ask ("how do I...", "can you track
      // expenses?", "what should I do about Bob?"), a request for the dashboard
      // link/sign-in, or a terse follow-up ("send it", "send the link") →
      // answer conversationally. The answerer has the book, the dashboard URL,
      // and the recent chat, so it can resolve "send the link" from context.
      const looksConversational =
        /\?/.test(rt) ||
        /\b(how|what|why|when|where|which|who|can you|could you|can i|do you|are you|is there|should i|what if|help me|c[oó]mo|qu[eé]|por qu[eé]|puedes|puedo|hay|cu[aá]l|qui[eé]n|deber[ií]a)\b/i.test(rt) ||
        /\b(link|dashboard|log ?in|sign ?in|website|url|address to|the app)\b/i.test(rt) ||
        /^\s*(send (it|the link|that)|yes send|go ahead|please do|s[ií]|mand[aá]lo|env[ií]a(lo|melo)?)\s*[.!]?\s*$/i.test(rt);
      if (looksConversational && /[a-zà-ÿ]{2,}/i.test(rt)) {
        return runQuery(business, { ...p, intent: "query", query_text: rt }, ctx);
      }
      // A partially-understood command → the menu; otherwise recovery copy.
      return p.confidence >= 0.4 ? t.helpHint(lang) : t.didntCatch(lang);
    }
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
): Promise<string | string[] | null> {
  const lang = session.lang ?? businessLang(business);
  if (new Date(pending.expiresAt).getTime() < Date.now()) return null;
  const a = answer.trim();

  if (pending.kind === "which_client") {
    const ids = pending.candidateIds ?? [];
    const all = await listClients(business.id);
    const cands = ids.map((id) => all.find((c) => c.id === id)).filter(Boolean) as Client[];
    let chosen: string | null = null;

    // 1. A number: "2", "(3)".
    const numM = a.match(/^\(?\s*([1-9])\s*\)?\.?$/);
    if (numM) chosen = ids[Number(numM[1]) - 1] ?? null;

    // 2. An ordinal word: "the first one", "second", "último".
    if (!chosen) {
      const ord = a.toLowerCase().match(/\b(first|1st|primero|second|2nd|segundo|third|3rd|tercero|fourth|4th|cuarto|last|[uú]ltim[oa])\b/);
      if (ord) {
        const idxMap: Record<string, number> = { first: 0, "1st": 0, primero: 0, second: 1, "2nd": 1, segundo: 1, third: 2, "3rd": 2, tercero: 2, fourth: 3, "4th": 3, cuarto: 3 };
        const idx = /last|[uú]ltim/.test(ord[1]) ? cands.length - 1 : idxMap[ord[1]];
        if (idx != null && idx >= 0) chosen = ids[idx] ?? null;
      }
    }

    // 3. A name / address — substring first, then shared-token (so "shackelford"
    // or "eric shackelford" both pick Eric Shackelford out of the Erics).
    if (!chosen) {
      const norm = a.toLowerCase().trim();
      const tokens = norm.split(/[\s,]+/).filter((w) => w.length >= 2);
      const scoreOf = (c: Client): number => {
        const name = c.name.toLowerCase();
        const addr = (c.address ?? "").toLowerCase();
        if (norm && (name.includes(norm) || (addr && addr.includes(norm)))) return 3;
        const nameTokens = name.split(/\s+/);
        const shared = tokens.filter((tk) => nameTokens.includes(tk) || (addr && addr.includes(tk))).length;
        return shared > 0 ? 1 + shared : 0;
      };
      const ranked = cands.map((c) => ({ c, s: scoreOf(c) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0].s > ranked[1].s)) chosen = ranked[0].c.id;
    }

    if (chosen) {
      const action: ParsedAction = { ...pending.action, client_id: chosen };
      return runAction(business, action, ctx, null, session, lang, a);
    }

    // Couldn't tell which. A confident, unrelated command ("the smiths paid 200")
    // must RUN, not be eaten as a failed pick. Only a genuinely pick-shaped reply
    // (bare name / number / address, no command) re-asks and keeps the question.
    const probe = heuristicParse(a, ctx).actions[0];
    const isCommand = !!probe && probe.intent !== "help" && probe.confidence >= 0.55;
    if (!isCommand && /^[\p{L}\d][\p{L}\d .,'’#-]*$/u.test(a.trim())) {
      session.pending = pending;
      const opts = cands.map((c, i) => `(${i + 1}) ${c.name}${c.address ? ` — ${c.address}` : ""}`).join("  ");
      return `${lang === "es" ? "Aún no sé cuál — " : "Still not sure which one — "}${t.whichClient(opts, lang)}`;
    }
    return null; // a command or a new topic — let it parse fresh
  }

  // "Whose site is this photo from?" — the reply names the client (or picks a
  // number from a list we showed, or gives the address).
  if (pending.kind === "attach_photo") {
    if (/^\s*(import|importar)\s*[.!]?\s*$/i.test(a)) return t.photoHint(lang);
    const saveTo = async (id: string, name: string) => {
      const saved = await saveMedia(business.id, id, pending.media ?? [], pending.action.note_text ?? null);
      return saved > 0 ? t.photoSaved(saved, name, lang) : t.errorSaving(lang);
    };
    // A numeric pick against a list we previously showed ("(1) Smiths (2) Smith Bros" → "2").
    const ids = pending.candidateIds ?? [];
    const numM = a.match(/^\(?\s*([1-9])\s*\)?\.?$/);
    if (ids.length && numM) {
      const picked = ids[Number(numM[1]) - 1];
      const c = picked ? (await listClients(business.id)).find((x) => x.id === picked) : null;
      if (c) return saveTo(c.id, c.name);
    }
    const found = await findClientInPhrase(business.id, a);
    if (found) return saveTo(found.id, found.name);
    // Match by name OR address, scored separately (a combined query would trip
    // the full-name veto). "the oak street job" / "12 oak st" resolve by address.
    const byName = await matchClientsScored(business.id, { name: a });
    const byAddr = await matchClientsScored(business.id, { address: a });
    const merged = new Map<string, { client: Client; score: number }>();
    for (const m of [...byName, ...byAddr]) {
      const cur = merged.get(m.client.id);
      if (!cur || m.score > cur.score) merged.set(m.client.id, m);
    }
    const matches = [...merged.values()].sort((x, y) => y.score - x.score);
    if (matches.length === 1 && matches[0].score >= STRONG_MATCH) return saveTo(matches[0].client.id, matches[0].client.name);
    if (matches.length > 1) {
      // Keep the photo waiting AND remember the shortlist so "2" resolves next.
      session.pending = { ...pending, candidateIds: matches.slice(0, 4).map((m) => m.client.id) };
      const opts = matches.slice(0, 4).map((m, i) => `(${i + 1}) ${m.client.name}${m.client.address ? ` — ${m.client.address}` : ""}`).join("  ");
      return t.whichClient(opts, lang);
    }
    if (/[a-zà-ÿ]{3,}|\d/i.test(a.trim())) {
      // Looked like an answer (a name or address) but no match — keep waiting.
      session.pending = pending;
      return t.notFound(a.trim(), lang);
    }
    return null; // unrelated text — normal parse takes over, photo expires
  }

  if (pending.kind === "confirm_match") {
    const candidateId = pending.candidateIds?.[0];
    // "yes" confirms — and so does naming the candidate ("yes, Eric Shackelford"
    // or just "Eric Shackelford"), which is what people naturally reply.
    let confirms = /^\s*(yes|yeah|yep|yup|correct|right|that'?s (?:him|her|it|them|the one|the guy|right)|s[ií]|s[ií] es (?:ella|[eé]l)|claro|dale|ok|okay|exacto|correcto)\s*[.!]?\s*$/i.test(a);
    if (!confirms && candidateId && /^(?:yes|s[ií])?[,\s]*[\p{L}][\p{L} .'’-]+$/u.test(a.trim())) {
      const cand = (await listClients(business.id)).find((c) => c.id === candidateId);
      if (cand) {
        const name = cand.name.toLowerCase();
        const reply = a.toLowerCase().replace(/^(yes|s[ií])[,\s]+/i, "").trim();
        const tks = reply.split(/\s+/).filter((w) => w.length >= 2);
        if (name.includes(reply) || tks.some((tk) => name.split(/\s+/).includes(tk))) confirms = true;
      }
    }
    if (confirms && candidateId) {
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
    if (/^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|go ahead|please do|do it|add (?:them|him|her)|s[ií]|claro|dale|h[aá]zlo|agr[eé]gal[oa])\s*[.!]?\s*$/i.test(a)) {
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
    if (/^\s*(no|nah|nope|don'?t|cancel|skip|forget it|no lo agregues|no gracias)\s*[.!]?\s*$/i.test(a)) {
      return lang === "es" ? "Ok, no lo agregué." : "Ok, didn't add them.";
    }
    return null;
  }

  if (pending.kind === "missing_amount") {
    // "don't know" / "idk" / "not sure" / "skip" → save without a price and move on.
    if (/^\s*(idk|don'?t know|dunno|not sure|no idea|unsure|no clue|who knows|beats me|not yet|nope|nothing|skip|later|tbd|n\/?a|\?+|no s[eé]|no estoy seguro|ni idea|luego|despu[eé]s)\b/i.test(a)) {
      const clientId = pending.action.client_id;
      if (clientId) {
        const all = await listClients(business.id);
        const c = all.find((x) => x.id === clientId);
        if (c) return finishIntake(c, pending.action, session, lang);
      }
      return null;
    }
    const n = normalizeAmount(a);
    if (n == null) {
      // Not a number and not a skip. If it's a real command, keep the price
      // question open (sticky) and let the command run; else drop through.
      const probe = heuristicParse(a, ctx).actions[0];
      if (probe && probe.intent !== "help" && probe.intent !== "update_client_info" && probe.confidence >= 0.55) {
        session.pending = pending;
      }
      return null;
    }
    // A period said with the price ("200 a month", "150/mo") sets billing too.
    const period = normalizePeriod(a);
    const action: ParsedAction = { ...pending.action, amount: n, ...(period ? { billing_period: period } : {}) };
    return runAction(business, action, ctx, null, session, lang, a);
  }

  // Completing a new client: pull phone / address / full name out of one reply.
  if (pending.kind === "complete_client") {
    const clientId = pending.action.client_id;
    if (!clientId) return null;
    const missing = pending.missing ?? [];

    // An UNAMBIGUOUS command mid-intake ("García pagó 150", "remind me friday")
    // is not an answer to the completeness question — let it parse. Kept narrow
    // so a real answer ("limpieza", a phone, an address) is never mistaken for one.
    const looksLikeCommand =
      /\b(paid|collected|owes?|venmo(?:ed|'d)?|zelled|remind me|invoice|receipt|spent|rained out)\b/i.test(a)
      // Accented words can't use a trailing \b (ó/é aren't word chars).
      || /(pag[oó]|cobr[eé]|deben|recu[eé]rdame|factura|recibo|llovi[oó]|gast[eé])/i.test(a)
      || /^\s*(quoted|quoting|coti[a-zà-ÿ]*|new job|new client)\b/i.test(a)
      // A correction aimed at a PRIOR entry, not an answer to this question.
      || /^\s*(fix|wrong|actually|corrige|cambia|en realidad)\b/i.test(a)
      || /\bit'?s\s+[\d.,$kK]+\s+not\s+[\d.,$kK]+/i.test(a);
    // Sticky: run the command, but KEEP chasing the intake so the operator's next
    // contact-info reply still lands (no more silently-abandoned half-setups).
    if (looksLikeCommand) { session.pending = pending; return null; }

    // Recurring-service scheduling step: "when does it start, how often, what day?"
    if (missing.length === 1 && missing[0] === "schedule") {
      const all0 = await listClients(business.id);
      const target = all0.find((c) => c.id === clientId);
      if (!target) return null;
      const nextStep = (name: string, prefix: string): string => {
        // Once scheduled, fall through to the optional notes step (or finish).
        if (!target.notes) {
          session.pending = { kind: "complete_client", action: pending.action, missing: ["notes"], expiresAt: pendingExpiry() };
          return `${prefix} ${t.anyNotes(name, lang)}`;
        }
        return prefix;
      };
      if (/^\s*(skip|no|none|nope|nah|nada|omitir|luego|later|n\/a)\s*[.!]?\s*$/i.test(a)) {
        return nextStep(target.name, t.allSet(target.name, lang));
      }
      // Don't swallow a real command ("bob paid 300") aimed elsewhere.
      const probe = heuristicParse(a, ctx).actions[0];
      if (probe && probe.intent !== "help" && probe.intent !== "update_client_info" && probe.confidence >= 0.55) {
        return null;
      }
      const sched = parseScheduleAnswer(a, ctx.nowISO);
      if (!sched.service_interval && !sched.next_service_on) {
        return t.needSchedule(target.name, lang); // couldn't read it — ask once more
      }
      // A start date with no stated cadence ("the 15th") inherits the billing
      // period, so the calendar still advances instead of stalling.
      if (sched.next_service_on && !sched.service_interval && target.billing_period && ["weekly", "biweekly", "monthly"].includes(target.billing_period)) {
        sched.service_interval = target.billing_period as "weekly" | "biweekly" | "monthly";
      }
      const saved = (await updateClient(clientId, sched)) ?? target;
      const when = [
        intervalWord(saved.service_interval, lang),
        saved.service_day ? saved.service_day.charAt(0).toUpperCase() + saved.service_day.slice(1) : "",
      ].filter(Boolean).join(", ") + (saved.next_service_on ? ` · ${lang === "es" ? "empieza" : "starts"} ${fmtDay(saved.next_service_on, lang)}` : "");
      return nextStep(saved.name, t.scheduleSaved(saved.name, when, lang));
    }

    // Final optional step: "anything to note?"
    if (missing.length === 1 && missing[0] === "notes") {
      const all0 = await listClients(business.id);
      const target = all0.find((c) => c.id === clientId);
      if (!target) return null;
      if (/^\s*(skip|no|none|nope|nah|nada|omitir|n\/a)\s*[.!]?\s*$/i.test(a)) {
        return t.allSet(target.name, lang);
      }
      // If the reply is clearly a NEW command ("bob paid 300"), don't eat it as a note.
      const probe = heuristicParse(a, ctx).actions[0];
      if (probe && probe.intent !== "help" && probe.intent !== "update_client_info" && probe.confidence >= 0.55) {
        return null; // normal parse takes over
      }
      const notes = target.notes ? `${target.notes}\n${a.trim()}` : a.trim();
      await updateClient(clientId, { notes });
      return t.noteSaved(target.name, lang);
    }
    const patch: Partial<Client> = {};
    let rest = a;

    if (missing.includes("phone")) {
      // Grab the longest phone-like token (handles US 3-3-4, one solid block,
      // and long international numbers). Format by digit count so a 14-digit
      // number is never truncated to 10 and wrongly US-normalized.
      const tokens = rest.match(/\+?\d[\d\s\-.()]{5,18}\d/g) ?? [];
      const best = tokens.map((s) => s.trim()).sort((a, b) => b.replace(/\D/g, "").length - a.replace(/\D/g, "").length)[0];
      if (best) {
        const digits = best.replace(/[^\d]/g, "");
        if (digits.length === 10) patch.phone = `+1${digits}`;
        else if (digits.length === 11 && digits.startsWith("1")) patch.phone = `+${digits}`;
        else patch.phone = digits; // international / non-standard: keep verbatim
        rest = rest.replace(best, " ").trim();
      }
    }
    // Strip phone-context filler ("her number is") so it never leaks into service/address.
    if (patch.phone) {
      rest = rest
        .replace(/\b(her|his|their|the|a|is|es|el|la|su|it'?s)\b/gi, " ")
        .replace(/\b(number|n[uú]mero|phone|tel(?:[eé]fono)?|cell|celular|m[oó]vil|contact)\b/gi, " ")
        .replace(/[#:]/g, " ")
        .replace(/\s+/g, " ").trim();
    }
    rest = rest.replace(/^[,;·-]+|[,;·-]+$/g, "").trim();
    if (rest) {
      // A house number OR a street word ("Main Street", "Elm Ct") means address —
      // so a digit-less street isn't misfiled as the service.
      const looksStreet = /\d/.test(rest)
        || /\b(st|street|ave|avenue|rd|road|ln|lane|dr|drive|blvd|boulevard|ct|court|way|pl|place|cir|circle|hwy|highway|apt|suite|ste|unit|calle|avenida)\b/i.test(rest);
      if (missing.includes("address") && looksStreet) {
        patch.address = normalizeAddress(rest);
      } else if (missing.includes("service")) {
        patch.service_description = rest.toLowerCase();
      } else if (missing.includes("address")) {
        patch.address = normalizeAddress(rest); // street name without a number
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
      : /* service */ !client.service_description
    );
    const savedBits = [
      patch.address ? client.address : null,
      patch.phone ? `📞 ${client.phone}` : null,
      patch.service_description ? client.service_description : null,
    ].filter(Boolean).join(" · ");
    if (stillMissing.length) {
      session.pending = { kind: "complete_client", action: pending.action, missing: stillMissing, expiresAt: pendingExpiry() };
      return `${t.infoSaved(client.name, savedBits, lang)} ${t.needInfo(client.name, stillMissing, lang)}`;
    }
    // Required profile complete — recurring clients get the scheduling step next.
    if (needsSchedule(client)) {
      session.pending = { kind: "complete_client", action: pending.action, missing: ["schedule"], expiresAt: pendingExpiry() };
      return `${t.infoSaved(client.name, savedBits, lang)} ${t.needSchedule(client.name, lang)}`;
    }
    // Then the optional notes step.
    if (!client.notes) {
      session.pending = { kind: "complete_client", action: pending.action, missing: ["notes"], expiresAt: pendingExpiry() };
      return `${t.infoSaved(client.name, savedBits, lang)} ${t.anyNotes(client.name, lang)}`;
    }
    return t.infoSaved(client.name, savedBits, lang);
  }

  // The quote close-loop: a nudge asked "did you send it / any word back?" and
  // this is the answer. Won/lost close it; anything else keeps us chasing.
  if (pending.kind === "quote_status") {
    const clientId = pending.action.client_id;
    if (!clientId) return null;
    const all = await listClients(business.id);
    const client = all.find((c) => c.id === clientId);
    if (!client) return null;

    const verdict = classifyQuoteStatus(a, ctx.nowISO);
    if (verdict === "won") {
      await updateClient(clientId, { status: "active", last_nudged_at: null });
      await cancelQuoteReminders(clientId, business.id);
      return t.quoteWon(client.name, lang);
    }
    if (verdict === "lost") {
      await updateClient(clientId, { status: "lost" });
      await cancelQuoteReminders(clientId, business.id);
      return t.quoteLostAck(client.name, lang);
    }
    if (verdict === "waiting") {
      // Keep chasing: replace the pre-scheduled sequence with ONE next check at
      // the time they asked for (or +6h by default). If they haven't SENT it yet
      // we re-ask "did you send it?"; if they've sent it we ask "any word back?".
      await cancelQuoteReminders(clientId, business.id);
      const notSent = /\b(not yet|haven'?t|didn'?t|no he|todav[ií]a no|sin enviar)\b/i.test(a);
      const amountStr = client.amount != null ? ` (${money(client.amount)}${periodLabel(client.billing_period, lang)})` : "";
      const text = notSent ? t.quoteAskSent(client.name, amountStr, lang) : t.quoteAskReply(client.name, amountStr, lang);
      const custom = resolveDate(a, ctx.nowISO);
      const dueISO = custom ? custom.iso : new Date(new Date(ctx.nowISO).getTime() + 6 * 60 * 60 * 1000).toISOString();
      await createReminder({ businessId: business.id, clientId, text, dueISO, kind: "quote_followup" });
      const whenStr = custom ? formatWhen(dueISO, business.timezone, lang) : (lang === "es" ? "en 6 h" : "in 6h");
      return t.quoteChaseAgain(client.name, whenStr, lang);
    }
    // Unrelated message — keep the question open (sticky) and let it parse normally.
    session.pending = pending;
    return null;
  }

  if (pending.kind === "quote_draft") {
    const clientId = pending.action.client_id;
    if (!clientId) return null;
    const client = (await listClients(business.id)).find((c) => c.id === clientId);
    if (!client) return null;
    const s = a.toLowerCase().trim();

    // "sent it" — the quote is out. Promote the prospect to a live quote and
    // start the follow-up chase so it doesn't go cold; drop the to-do reminders.
    if (/\b(sent|done|emailed|texted|delivered|just sent|gave (?:it|her|him|them))\b/i.test(s)
      || /\b(envi[eé]|mand[eé]|ya (?:la|le))\b/i.test(s)) {
      if (client.status !== "active" && client.status !== "lost") await updateClient(clientId, { status: "quoted" });
      // Cancel any remaining "send X a quote" to-dos for this client (fetch+filter
      // so it works on both Supabase and the file-backed test DB).
      const { data: todos } = await db().from("reminders").select("id, text")
        .eq("business_id", business.id).eq("client_id", clientId).eq("kind", "manual").eq("status", "pending");
      for (const rr of (todos ?? []) as { id: string; text: string }[]) {
        if (/\bquote\b|cotiz/i.test(rr.text)) await db().from("reminders").update({ status: "cancelled" }).eq("id", rr.id);
      }
      await scheduleQuoteReminders(business, { ...client, status: "quoted" });
      return t.quoteDraftSentAck(client.name, lang);
    }
    // "draft" / "yes" — send TWO texts: instructions, then the clean copy-paste
    // message. Keep listening for SENT.
    if (/\b(draft|write|yes|yeah|yep|sure|okay?|please|do it|help)\b/i.test(s)
      || /\b(borrador|escrib|s[ií]|dale|hazlo)\b/i.test(s)) {
      session.pending = { kind: "quote_draft", action: pending.action, expiresAt: pendingExpiry() };
      return [t.quoteDraftIntro(client, lang), t.quoteDraftMessage(client, lang)];
    }
    // "no / later" — drop it for now (don't nag; let a real command through otherwise).
    if (/^(no|nope|nah|not now|later|skip|stop|luego|despu[eé]s)\b/i.test(s)) {
      return t.quoteDraftSkip(client.name, lang);
    }
    // Anything else is probably a real command — let it parse normally.
    return null;
  }

  if (pending.kind === "update_field") {
    const clientId = pending.action.client_id;
    const field = pending.field as "address" | "phone" | "email" | "note" | undefined;
    if (!clientId || !field) return null;
    const client = (await listClients(business.id)).find((c) => c.id === clientId);
    if (!client) return null;
    const val = a.trim();
    if (!val) { session.pending = pending; return askForField(field, client.name, lang); }

    const patch: Partial<Client> = {};
    let saved = "";
    if (field === "address") { patch.address = normalizeAddress(val); saved = `📍 ${patch.address}`; }
    else if (field === "phone") { const e = toE164(val) ?? val; patch.phone = e; saved = `📞 ${e}`; }
    else if (field === "email") { patch.email = val.toLowerCase(); saved = `✉️ ${val.toLowerCase()}`; }
    else { patch.notes = client.notes ? `${client.notes}\n${val}` : val; saved = lang === "es" ? `nota: "${val}"` : `note: "${val}"`; }
    await updateClient(clientId, patch);
    return t.infoSaved(client.name, saved, lang);
  }
  return null;
}

/** Read a quote-status reply. Ambiguous defaults to "waiting" — we stay on them. */
function classifyQuoteStatus(a: string, _nowISO: string): "won" | "lost" | "waiting" | "unknown" {
  const s = a.toLowerCase().trim();
  // Clear acceptance only (bare "yes" means "yes I sent it" → waiting, not won).
  if (/\b(they'?re in|(?:they |he |she )?accepted|say yes|said yes|signed|booked|hired|we won|closed the deal|on board|good to go|let'?s go)\b/i.test(s)
    || /\b(acept[oó]|aceptaron|firm[oó]|contrat[oó]|de acuerdo|adentro)\b/i.test(s)) return "won";
  // Clear loss. "OUT" counts — but not "sent it out" (that means they sent it).
  const saysOut = /^\s*out\.?\s*$/i.test(s)
    || /\b(they'?re|they are|he'?s|she'?s)\s+out\b/i.test(s)
    || /\bout on (?:this|it|the quote)\b/i.test(s);
  if (/\b(passed|pass|declined|decline|not interested|went with|going with|ghosted|gone cold|it'?s dead|dead lead|lost it)\b/i.test(s)
    || /\b(pas[oó]|rechaz|no quiso|no quieren|perd[ií]|se fue con|fuera)\b/i.test(s)
    || saysOut) return "lost";
  // Anything status-ish (or a date, or a bare yes/no) → keep chasing.
  if (/\b(not yet|no reply|no response|no word|nothing|haven'?t|hasn'?t|didn'?t|still|waiting|sent|send|pending|soon|tomorrow|today|tonight|later|next|no|nope|yes|yep|yeah|remind|check)\b/i.test(s)
    || /\b(todav[ií]a no|sin respuesta|esperando|enviad|mand[eé]|luego|ma[ñn]ana|s[ií]|recu[eé]rda)\b/i.test(s)
    || resolveDate(a, _nowISO) != null) return "waiting";
  return "unknown";
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

const RECURRING_PERIODS = new Set(["weekly", "biweekly", "monthly"]);
/**
 * A recurring-service client (billed weekly/biweekly/monthly) whose visit
 * schedule we don't actually know yet. "$100/month" tells us the billing, not
 * WHEN the visits happen — without that, the calendar is just guessing.
 */
function needsSchedule(c: Client): boolean {
  const recurring = RECURRING_PERIODS.has(c.billing_period ?? "") || !!c.service_interval;
  return recurring && !c.service_interval;
}

/**
 * Turn a free-text schedule answer ("weekly on mondays starting next monday",
 * "monthly on the 1st", "every other friday") into a service-schedule patch.
 * An explicit start date anchors next_service_on; otherwise we compute it.
 * Returns {} when nothing schedule-like was found (so the caller can re-ask).
 */
function parseScheduleAnswer(text: string, nowISO: string): Partial<Client> {
  const lower = text.toLowerCase();
  let interval: "weekly" | "biweekly" | "monthly" | undefined;
  if (/(every other|bi-?weekly|cada dos|quincenal)/.test(lower)) interval = "biweekly";
  else if (/(month|mensual)/.test(lower)) interval = "monthly";
  else if (/(week|semanal|semana)/.test(lower)) interval = "weekly";
  const day = normalizeWeekday(text) ?? null;
  // A weekday with no explicit cadence ("mondays") means weekly.
  if (!interval && day) interval = "weekly";
  const date = resolveDate(text, nowISO);

  const patch: Partial<Client> = {};
  if (interval) patch.service_interval = interval;
  if (day) patch.service_day = day;
  if (date) patch.next_service_on = date.ymd;
  else if (interval) patch.next_service_on = computeNextService(interval, day, nowISO) ?? null;
  return patch;
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
    // Never silently resurrect a REMOVED client. If the only match was removed
    // (completed/lost), confirm bringing them back rather than assuming it's them.
    if (matches.length === 1 && p.client_name && (matches[0].client.status === "completed" || matches[0].client.status === "lost")) {
      session.pending = { kind: "confirm_match", action: p, candidateIds: [matches[0].client.id], expiresAt: pendingExpiry() };
      return t.reAddRemoved(matches[0].client.name, p.client_name, lang);
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
        // Implicit notes ("...big dog in back, gate code 1187") ride along.
        notes: p.note_text ? (client.notes ? `${client.notes}\n${p.note_text}` : p.note_text) : client.notes,
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
      notes: p.note_text ?? null,
      status: targetStatus,
      ...sched,
    });
  }

  // "Need to send quote for Jane" — a prospect we haven't priced yet. Don't chase
  // the amount (there isn't one) and don't fire quote-followup nudges (nothing
  // was quoted). Go straight to collecting their contact info.
  if (p.awaiting_quote) {
    await cancelQuoteReminders(client.id, business.id);
    return finishIntake(client, { ...p, client_id: client.id, client_is_new: isNew }, session, lang);
  }

  if (targetStatus === "quoted") await scheduleQuoteReminders(business, client);
  else await cancelQuoteReminders(client.id, business.id);

  // Missing the price? Save what we have, remember the question, ask for it.
  // (client_is_new keeps the completeness chase alive after the price arrives.)
  if (client.amount == null) {
    session.pending = { kind: "missing_amount", action: { ...p, client_id: client.id, client_is_new: isNew }, expiresAt: pendingExpiry() };
    return t.whatAmount(client.name, lang);
  }

  return finishIntake(client, { ...p, client_id: client.id, client_is_new: isNew }, session, lang);
}

/**
 * Confirm a saved client and, if it's brand new, chase the mandatory profile
 * (address, phone, service) then the optional notes step. Shared by logQuote
 * and the price-skip path so "don't know the price" still finishes intake.
 */
function finishIntake(client: Client, baseAction: ParsedAction, session: ActionSession, lang: Lang): string {
  const confirmation = baseAction.awaiting_quote
    ? t.prospectAdded(client.name, lang)
    : t.quoteLogged(clientSummary(client, lang), lang);
  // Chase details for a brand-new client OR whenever you're adding a quote
  // prospect (you'll want their address/phone before you send the quote), as
  // long as something's actually missing.
  const shouldChase = baseAction.client_is_new || baseAction.awaiting_quote;
  if (!shouldChase) return confirmation;
  // Chase the useful profile fields. (Name is NOT chased — "García" / "The Smiths"
  // are perfectly valid client names.)
  const missing: string[] = [];
  if (!client.address) missing.push("address");
  if (!client.phone) missing.push("phone");
  if (!client.service_description) missing.push("service");
  if (missing.length) {
    session.pending = { kind: "complete_client", action: { ...baseAction, client_id: client.id }, missing, expiresAt: pendingExpiry() };
    return `${confirmation}\n${t.needInfo(client.name, missing, lang)}`;
  }
  // A bare quote prospect isn't a scheduled client yet — skip the schedule step.
  // Recurring service with no visit schedule yet → ask when it starts, how
  // often, and what day (the anchor the calendar and reminders depend on).
  if (!baseAction.awaiting_quote && needsSchedule(client)) {
    session.pending = { kind: "complete_client", action: { ...baseAction, client_id: client.id }, missing: ["schedule"], expiresAt: pendingExpiry() };
    return `${confirmation}\n${t.needSchedule(client.name, lang)}`;
  }
  if (!client.notes) {
    session.pending = { kind: "complete_client", action: { ...baseAction, client_id: client.id }, missing: ["notes"], expiresAt: pendingExpiry() };
    return `${confirmation}\n${t.anyNotes(client.name, lang)}`;
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
  if (p.status && p.status !== "quoted") await cancelQuoteReminders(c.id, business.id);
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
  let client = matches.length === 1 ? matches[0] : null;

  // "remind me to quote Mitch K" — a quote to-do for someone not in the book yet.
  // Create them as a prospect and link the reminder, so it fires with the draft
  // offer (instead of a bare "Reminder: quote mitch k" with no one attached).
  let createdProspect = false;
  if (!client && /\b(quote|cotiz)/i.test(text)) {
    const name = p.client_name ?? quoteReminderName(text);
    if (name) {
      const byName = await matchClients(business.id, { name });
      if (byName.length === 1) client = byName[0];
      else {
        client = await createClient(business.id, { name, status: "quoted" });
        createdProspect = true;
      }
    }
  }

  await createReminder({ businessId: business.id, text, dueISO: p.due_at, clientId: client?.id ?? null, sourceMessageId, kind: "manual" });
  const when = formatWhen(p.due_at, business.timezone, lang);
  return createdProspect && client
    ? t.reminderSetProspect(when, client.name, lang)
    : t.reminderSet(when, text, lang);
}

/** Pull the person's name out of a "quote X" / "send X a quote" reminder text. */
function quoteReminderName(text: string): string | null {
  const m =
    text.match(/\bsend\s+(?:a\s+|the\s+)?quote\s+(?:for|to)\s+(.+)$/i) ||
    text.match(/\bsend\s+(.+?)\s+(?:a\s+|the\s+|an\s+)?quote\b/i) ||
    text.match(/\bquote\s+(?:for\s+|to\s+)?(.+)$/i);
  if (!m) return null;
  const raw = m[1].trim().replace(/[.?!,]+$/, "");
  if (!raw || raw.length > 40 || !/[a-zà-ÿ]/i.test(raw)) return null;
  return normalizeName(raw) || null;
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
async function logExpense(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  if (p.amount == null) return lang === "es" ? "¿De cuánto fue el gasto?" : "How much was the expense?";
  const today = todayInTz(business.timezone);
  const category = p.expense_category ?? "other";
  const description = p.note_text ?? p.job_description ?? null;

  // "spent 100 on mulch for Elena" → tie it to Elena's card (per-client costing).
  // Only when a client was named; a bad/ambiguous name asks rather than guessing.
  let client: Client | null = null;
  if (p.client_name || p.client_id) {
    const r = await resolveClient(business, p, session, lang);
    if (!r.client && r.ask) return r.ask; // ambiguous / not found → clarify, don't drop it
    client = r.client;
  }

  await db().from("expenses").insert({
    business_id: business.id, client_id: client?.id ?? null,
    amount: p.amount, category, description, spent_on: p.performed_on ?? today,
  });
  return client
    ? t.expenseLoggedFor(money(p.amount), client.name, description ?? category, lang)
    : t.expenseLogged(money(p.amount), category, description ?? "", lang);
}

async function updateClientInfo(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang, { offerCreate: true });
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);

  const patch: Partial<Client> = {};
  const saved: string[] = [];
  if (p.address) { patch.address = normalizeAddress(p.address); saved.push(`📍 ${patch.address}`); }
  if (p.phone) { patch.phone = p.phone; saved.push(`📞 ${p.phone}`); }
  if (p.email) { patch.email = p.email; saved.push(`✉️ ${p.email}`); }
  if (p.referred_by) { patch.referred_by = p.referred_by; saved.push(lang === "es" ? `referido por ${p.referred_by}` : `referred by ${p.referred_by}`); }
  if (p.note_text) {
    patch.notes = client.notes ? `${client.notes}\n${p.note_text}` : p.note_text;
    saved.push(lang === "es" ? `nota: "${p.note_text}"` : `note: "${p.note_text}"`);
  }
  if (!saved.length) {
    // "add Mitch address" — they named a field but no value yet. Ask for it and
    // capture the next reply as that field (no other chasing).
    if (p.collect_field) {
      session.pending = { kind: "update_field", action: { intent: "update_client_info", confidence: 1, client_id: client.id, client_name: client.name }, field: p.collect_field, expiresAt: pendingExpiry() };
      return askForField(p.collect_field, client.name, lang);
    }
    return lang === "es" ? `¿Qué guardo para ${client.name}?` : `What should I save for ${client.name}?`;
  }
  await updateClient(client.id, patch);
  return t.infoSaved(client.name, saved.join(" · "), lang);
}

function askForField(field: "address" | "phone" | "email" | "note", name: string, lang: Lang): string {
  const q: Record<string, [string, string]> = {
    address: [`What's ${name}'s address?`, `¿Cuál es la dirección de ${name}?`],
    phone: [`What's ${name}'s phone number?`, `¿Cuál es el teléfono de ${name}?`],
    email: [`What's ${name}'s email?`, `¿Cuál es el correo de ${name}?`],
    note: [`What's the note for ${name}?`, `¿Qué nota agrego para ${name}?`],
  };
  return lang === "es" ? q[field][1] : q[field][0];
}

async function pauseClient(business: Business, p: ParsedAction, session: ActionSession, lang: Lang): Promise<string> {
  const { client, ask } = await resolveClient(business, p, session, lang);
  if (!client) return ask ?? t.notFound(p.client_name ?? "", lang);
  await updateClient(client.id, { status: "paused", paused_until: p.pause_until ?? null, next_service_on: null });
  await cancelQuoteReminders(client.id, business.id);
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
  // Recent exchange as context so terse follow-ups ("images?") aren't amnesia.
  const { data: msgRows } = await db()
    .from("messages").select("*").eq("business_id", business.id)
    .order("created_at", { ascending: false }).limit(8);
  const transcript = ((msgRows ?? []) as { direction: string; body: string }[])
    .reverse()
    .map((m) => `${m.direction === "inbound" ? "OWNER" : "YOU"}: ${m.body.slice(0, 160)}`)
    .join("\n");
  const { text, usage } = await answerQuery(p.query_text || "status", snapshot, ctx, transcript);
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
  // The real dashboard link, so "send the link" / "how do I sign in" get a direct answer.
  lines.push(`DASHBOARD LINK: ${config.appUrl()}/dashboard — sign in with your mobile number + your dashboard password.`);
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

  // Site photos: counts per client — viewable on the dashboard, not sendable by SMS.
  const { data: attRows } = await db().from("attachments").select("*").eq("business_id", business.id);
  const photoCounts = new Map<string | null, number>();
  for (const a of (attRows ?? []) as { client_id: string | null }[]) photoCounts.set(a.client_id, (photoCounts.get(a.client_id) ?? 0) + 1);
  if (photoCounts.size) {
    lines.push(`SITE PHOTOS (texted in; the owner views them on the client's card in the dashboard — you cannot send them back by SMS):`);
    for (const [cid, n] of photoCounts) lines.push(`- ${nameOf(cid)}: ${n} photo(s)`);
  }
  return lines.join("\n");
}

export { generateDueCharges, totalOutstanding, openBalances };
