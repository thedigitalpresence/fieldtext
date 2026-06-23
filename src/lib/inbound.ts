import { db, getBusinessById, findAuthorizedPhone } from "./supabase";
import { toE164 } from "./phone";
import { parseMessage, ParseContext } from "./anthropic";
import { executeParsed } from "./intents";
import { listClients } from "./clients";
import { logMessage } from "./twilio";
import { logSms, logLlm } from "./billing";
import { businessLang, t } from "./templates";
import type { Lang } from "./types";

export interface InboundParams { from: string; to: string; body: string; messageSid?: string }
export interface InboundOutcome { twiml: string; authorized: boolean }

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "baja", "cancelar"]);
const START_WORDS = new Set(["start", "unstop", "alta", "continuar"]);
function replyTwiml(message: string): string {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/**
 * Handle one inbound SMS from the landscaper:
 *   authorize -> parse (LLM, EN/ES/Spanglish, multi-action) -> normalize ->
 *   execute -> reply in the operator's language -> log all.
 * Texts from unauthorized numbers are silently ignored (security requirement).
 */
export async function handleInbound(params: InboundParams): Promise<InboundOutcome> {
  const fromE164 = toE164(params.from) ?? params.from;
  const body = (params.body || "").trim();

  const authPhone = await findAuthorizedPhone(fromE164);
  if (!authPhone) {
    console.warn(`[inbound] ignoring text from unauthorized number ${fromE164}`);
    return { twiml: EMPTY_TWIML, authorized: false };
  }

  const business = await getBusinessById(authPhone.business_id);
  const lang = businessLang(business);

  // ── A2P compliance: STOP / START ────────────────────────────────────────────
  const kw = body.toLowerCase().replace(/[^a-z]/g, "");
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

  // ── Idempotency: Twilio retries webhooks; never double-process a MessageSid ──
  if (params.messageSid) {
    const { data: dup } = await db()
      .from("messages").select("id").eq("business_id", business.id).eq("external_id", params.messageSid).maybeSingle();
    if (dup) return { twiml: EMPTY_TWIML, authorized: true };
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

  const { result, usage } = await parseMessage(body, ctx);

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
    await db().from("businesses").update({ settings: { ...(business.settings ?? {}), language: newLang } }).eq("id", business.id);
    reply = t.languageSet(newLang);
  } else {
    try {
      reply = await executeParsed(business, result, ctx, inboundId);
    } catch (e) {
      console.error("[inbound] execute failed:", e);
      reply = t.errorSaving(lang);
    }
  }

  const outboundId = await logMessage({ businessId: business.id, direction: "outbound", body: reply });
  await logSms(business, { direction: "outbound", body: reply, messageId: outboundId });
  return { twiml: replyTwiml(reply), authorized: true };
}
