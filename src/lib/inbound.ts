import { db, getBusinessById, findAuthorizedPhone } from "./supabase";
import { toE164 } from "./phone";
import { parseMessage, ParseContext } from "./anthropic";
import { executeParsed, resolvePending, ActionSession } from "./intents";
import { listClients } from "./clients";
import { logMessage } from "./twilio";
import { logSms, logLlm } from "./billing";
import { businessLang, t } from "./templates";
import type { Lang, PendingState } from "./types";

export interface InboundParams { from: string; to: string; body: string; messageSid?: string; numMedia?: number }
export interface InboundOutcome { twiml: string; authorized: boolean }

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
// Carrier opt-out words ONLY. "cancel"/"end"/"quit" are everyday operator words
// ("cancel the reminder") and must never silently unsubscribe — they get a
// clarifying reply instead.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "baja"]);
const AMBIGUOUS_STOP = new Set(["cancel", "end", "quit", "cancelar"]);
const START_WORDS = new Set(["start", "unstop", "alta", "continuar"]);
function replyTwiml(message: string): string {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/**
 * Handle one inbound SMS from the landscaper:
 *   authorize -> resolve any pending question -> parse (LLM, EN/ES/Spanglish,
 *   multi-action) -> normalize -> execute -> reply in the operator's language -> log.
 * Texts from unauthorized numbers are silently ignored (security requirement).
 */
export async function handleInbound(params: InboundParams): Promise<InboundOutcome> {
  const fromE164 = toE164(params.from) ?? params.from;
  const body = (params.body || "").trim();

  const authPhone = await findAuthorizedPhone(fromE164);
  if (!authPhone) {
    console.warn(`[inbound] ignoring text from unauthorized number ending ...${fromE164.slice(-4)}`);
    return { twiml: EMPTY_TWIML, authorized: false };
  }

  const business = await getBusinessById(authPhone.business_id);
  // Per-phone language override (ES crew phone, EN owner phone).
  const lang: Lang = (authPhone.language as Lang) ?? businessLang(business);

  // ── A2P compliance: STOP / START ────────────────────────────────────────────
  const kw = body.toLowerCase().replace(/[^a-zà-ÿ]/g, "");
  if (STOP_WORDS.has(kw)) {
    await db().from("authorized_phones").update({ opted_out: true }).eq("id", authPhone.id);
    await logMessage({ businessId: business.id, direction: "inbound", fromPhone: fromE164, body, intent: "stop", externalId: params.messageSid });
    return { twiml: replyTwiml(t.optedOut(lang)), authorized: true };
  }
  if (authPhone.opted_out) {
    if (START_WORDS.has(kw)) {
      await db().from("authorized_phones").update({ opted_out: false }).eq("id", authPhone.id);
      await logMessage({ businessId: business.id, direction: "inbound", fromPhone: fromE164, body, intent: "start", externalId: params.messageSid });
      return { twiml: replyTwiml(t.optedIn(lang)), authorized: true };
    }
    return { twiml: EMPTY_TWIML, authorized: true }; // opted out — ignore everything else
  }
  // "cancel"/"end"/"quit" alone: ask what they meant instead of unsubscribing.
  if (AMBIGUOUS_STOP.has(kw)) {
    await logMessage({ businessId: business.id, direction: "inbound", fromPhone: fromE164, body, intent: "help", externalId: params.messageSid });
    return { twiml: replyTwiml(t.cancelWhat(lang)), authorized: true };
  }

  // ── Idempotency: Twilio retries webhooks; never double-process a MessageSid ──
  if (params.messageSid) {
    const { data: dup } = await db()
      .from("messages").select("id").eq("business_id", business.id).eq("external_id", params.messageSid).maybeSingle();
    if (dup) return { twiml: EMPTY_TWIML, authorized: true };
  }

  // ── First contact: welcome + guided first log ────────────────────────────────
  const { data: prior } = await db()
    .from("messages").select("id").eq("business_id", business.id)
    .eq("direction", "inbound").eq("from_phone", fromE164).limit(1);
  const isFirstText = !((prior ?? []) as unknown[]).length;

  // ── Photo texted in: point at the import flow (vision import lives there) ────
  if ((params.numMedia ?? 0) > 0 && body.length < 4) {
    await logMessage({ businessId: business.id, direction: "inbound", fromPhone: fromE164, body: body || "(photo)", intent: "help", externalId: params.messageSid });
    return { twiml: replyTwiml(t.photoHint(lang)), authorized: true };
  }

  const clients = await listClients(business.id);
  const ctx: ParseContext = {
    nowISO: new Date().toISOString(),
    timezone: business.timezone,
    businessName: business.name,
    ownerName: business.owner_name,
    lang,
    knownClients: clients.map((c) => ({ name: c.name, address: c.address })),
  };
  const session: ActionSession = { pending: null, lang };

  // ── Conversation memory: does this text answer our last question? ───────────
  if (authPhone.pending_state) {
    try {
      const resolved = await resolvePending(business, authPhone.pending_state as PendingState, body, ctx, session);
      if (resolved != null) {
        await db().from("authorized_phones").update({ pending_state: session.pending ?? null }).eq("id", authPhone.id);
        const inId = await logMessage({ businessId: business.id, direction: "inbound", fromPhone: fromE164, body, intent: "clarification", externalId: params.messageSid });
        await logSms(business, { direction: "inbound", body, messageId: inId });
        const outId = await logMessage({ businessId: business.id, direction: "outbound", body: resolved });
        await logSms(business, { direction: "outbound", body: resolved, messageId: outId });
        return { twiml: replyTwiml(resolved), authorized: true };
      }
      // Unrelated text — clear the stale question and parse normally.
      await db().from("authorized_phones").update({ pending_state: null }).eq("id", authPhone.id);
    } catch (e) {
      console.error("[inbound] pending resolution failed:", e);
    }
  }

  // ── Parse (never let a parser failure turn into silence) ─────────────────────
  let result, usage;
  try {
    ({ result, usage } = await parseMessage(body, ctx));
  } catch (e) {
    console.error("[inbound] parse failed:", e);
    const inId = await logMessage({ businessId: business.id, direction: "inbound", fromPhone: fromE164, body, intent: "help", externalId: params.messageSid });
    await logSms(business, { direction: "inbound", body, messageId: inId });
    return { twiml: replyTwiml(t.didntCatch(lang)), authorized: true };
  }

  // Always log the RAW inbound text for audit (the dashboard never shows it).
  const inboundId = await logMessage({
    businessId: business.id,
    direction: "inbound",
    fromPhone: fromE164,
    body,
    intent: result.actions[0]?.intent ?? (result.set_language ? "set_language" : "help"),
    entities: result as unknown as Record<string, unknown>,
    externalId: params.messageSid,
  });
  await logSms(business, { direction: "inbound", body, messageId: inboundId });
  await logLlm(business, "llm_parse", usage);

  let reply: string;
  // Language switch is its own short flow, confirmed in the NEW language.
  if (result.set_language) {
    const newLang: Lang = result.set_language;
    // Set it on THIS phone (crew phones can differ from the business default).
    await db().from("authorized_phones").update({ language: newLang }).eq("id", authPhone.id);
    if (authPhone.is_primary) {
      await db().from("businesses").update({ settings: { ...(business.settings ?? {}), language: newLang } }).eq("id", business.id);
    }
    reply = t.languageSet(newLang);
  } else {
    try {
      reply = await executeParsed(business, result, ctx, inboundId, session, body);
    } catch (e) {
      console.error("[inbound] execute failed:", e);
      reply = t.errorSaving(lang);
    }
  }

  // Persist (or clear) the pending question for the next text.
  await db().from("authorized_phones").update({ pending_state: session.pending ?? null }).eq("id", authPhone.id);

  // First-ever text from this phone: lead with a welcome.
  if (isFirstText) reply = `${t.welcome(business.owner_name, lang)}\n\n${reply}`;

  const outboundId = await logMessage({ businessId: business.id, direction: "outbound", body: reply });
  await logSms(business, { direction: "outbound", body: reply, messageId: outboundId });
  return { twiml: replyTwiml(reply), authorized: true };
}
