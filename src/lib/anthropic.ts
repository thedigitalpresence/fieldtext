/**
 * The LLM parsing layer — the heart of FieldText.
 *
 * parseMessage() turns a landscaper's plain-language text (English, Spanish, or
 * Spanglish — capitalized or not, abbreviated, typo-ridden, multiple facts in one
 * message) into a structured { actions: [...], needs_clarification?, set_language? }
 * via Claude tool-calling (forced single tool = guaranteed schema-valid output).
 * Every action is then re-normalized in code (see normalize.ts) — we never trust
 * the model's formatting blindly. answerQuery() composes a short SMS answer.
 *
 * One language-agnostic pipeline. When LLM_DRY_RUN is on (or no API key), a
 * built-in heuristic parser runs instead so the app works locally with no key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { normalizeAction, normalizeWeekday, NormalizeContext } from "./normalize";
import type { Intent, ParsedAction, ParseResult, LlmUsage, Lang } from "./types";

export interface ParseContext extends NormalizeContext {
  businessName: string;
  ownerName: string;
  lang: Lang;
  knownClients: { name: string; address: string | null }[];
}
export interface ParseOutput { result: ParseResult; usage: LlmUsage | null }
export interface QueryResult { text: string; usage: LlmUsage | null }

let _anthropic: Anthropic | null = null;
function anthropic() {
  // Twilio abandons webhooks at ~15s: keep the parse call well inside that window
  // (8s hard timeout, no SDK retries — a missed parse beats a double-processed one).
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: config.anthropic.apiKey(), timeout: 8000, maxRetries: 0 });
  return _anthropic;
}

// ── Explicit language switch ("español" / "english") ──────────────────────────
function detectLanguageSwitch(text: string): Lang | null {
  const t = text.trim().toLowerCase();
  if (/^\s*(espa[nñ]ol|spanish|en espa[nñ]ol)\s*$/.test(t)) return "es";
  if (/^\s*(english|ingl[eé]s|en ingl[eé]s)\s*$/.test(t)) return "en";
  return null;
}

// ── Tool schema: every parse returns an array of actions ──────────────────────
const ACTION_PROPS = {
  intent: {
    type: "string",
    enum: [
      "log_quote", "update_status", "log_job", "log_payment", "set_reminder", "correction", "query", "help",
      "log_expense", "update_client_info", "pause_client", "resume_client",
      "skip_visit", "reschedule_visit", "bulk_reschedule", "price_change", "request_invoice",
    ],
  },
  confidence: { type: "number", description: "0-1 confidence." },
  client_name: { type: "string" },
  address: { type: "string" },
  amount: { type: "number", description: "Numeric, no $ or commas." },
  billing_period: { type: "string", enum: ["one_time", "weekly", "biweekly", "monthly"] },
  service_description: { type: "string", description: "Short phrase, e.g. 'full coverage', 'mowing'." },
  status: { type: "string", enum: ["quoted", "active", "completed", "lost"] },
  awaiting_quote: { type: "boolean", description: "log_quote for a prospect you still need to send a price to (no amount yet), e.g. 'need to send quote for Jane'." },
  service_interval: { type: "string", enum: ["weekly", "biweekly", "monthly"], description: "Recurring service cadence." },
  service_day: { type: "string", description: "Preferred service day, e.g. 'tuesday'." },
  job_description: { type: "string" },
  performed_on: { type: "string", description: "YYYY-MM-DD" },
  paid_on: { type: "string", description: "YYYY-MM-DD" },
  payment_status: { type: "string", enum: ["paid", "unpaid", "overdue"], description: "For log_payment: collected=paid, owes=unpaid." },
  reminder_text: { type: "string" },
  due_at: { type: "string", description: "Full ISO 8601 with offset." },
  query_text: { type: "string" },
  correction_text: { type: "string", description: "What to fix on the last record." },
  // roadmap entities
  note_text: { type: "string", description: "update_client_info: gate codes / free-form client notes." },
  phone: { type: "string", description: "update_client_info: client's phone." },
  email: { type: "string", description: "update_client_info: client's email." },
  referred_by: { type: "string", description: "update_client_info: who referred this client." },
  collect_field: { type: "string", enum: ["address", "phone", "email", "note"], description: "update_client_info when the user wants to ADD/SET a field but gave NO value yet (e.g. 'add Mitch address', 'set Jane phone'). Set this to the field; the app asks for the value. If a value IS given, fill address/phone/email/note_text directly instead." },
  expense_category: { type: "string", enum: ["materials", "fuel", "equipment", "labor", "other"], description: "log_expense category." },
  target_date: { type: "string", description: "YYYY-MM-DD for reschedule_visit / bulk_reschedule." },
  pause_until: { type: "string", description: "YYYY-MM-DD resume date for pause_client, if given." },
  invoice_kind: { type: "string", enum: ["invoice", "receipt"], description: "request_invoice." },
  payment_method: { type: "string", enum: ["cash", "check", "venmo", "zelle", "other"], description: "log_payment: how they paid, if mentioned." },
  scheduled_on: { type: "string", description: "YYYY-MM-DD when a job is booked for a FUTURE date ('mulch next tuesday')." },
};
const RECORD_TOOL = {
  name: "record_actions",
  description: "Record the structured interpretation of the message. Always call this exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      actions: { type: "array", items: { type: "object", properties: ACTION_PROPS, required: ["intent", "confidence"] } },
      needs_clarification: { type: "string", description: "A short question to ask instead of saving, when unclear." },
      set_language: { type: "string", enum: ["en", "es"], description: "Set only if the operator asks to switch language." },
    },
    required: ["actions"],
  },
};

function systemPrompt(ctx: ParseContext): string {
  const clientList =
    ctx.knownClients.length > 0
      ? ctx.knownClients.map((c) => `- ${c.name}${c.address ? ` (${c.address})` : ""}`).join("\n")
      : "(none yet)";
  return [
    `You parse text messages a landscaping business owner (${ctx.ownerName} at ${ctx.businessName}) sends to log and manage their business by SMS.`,
    `The owner texts fast: lowercase, no punctuation, abbreviations, typos, English / Spanish / Spanglish, and often several facts in one message. Detect the language per message and extract the same canonical data regardless.`,
    `Return an ARRAY of actions via the record_actions tool — one message can contain several. ALWAYS split these out:`,
    `  • "Quoting James at 222 West St, need to send the quote tomorrow" = TWO actions: log_quote (James, 222 West St) AND set_reminder (reminder_text "send James quote", due tomorrow).`,
    `  • set_reminder: reminder_text is the TASK ONLY — time words NEVER belong in it. "New reminder for elena send later today" = client_name "Elena", due_at today, reminder_text "send" (NOT "send later"; "later today" is the WHEN). "call bob tomorrow morning" -> reminder_text "call bob", due tomorrow morning.`,
    `  • "Need to send quote for Jane" / "gotta quote Jane" / "send Jane a quote" (a prospect you haven't priced yet) = TWO actions: log_quote (Jane, awaiting_quote=true, NO amount — this creates the prospect so their phone/notes get collected) AND set_reminder (reminder_text "send Jane quote", due tomorrow if no date given). Do NOT invent an amount for these.`,
    `  • An obligation phrase — "need to / gotta / have to / got to / don't forget to / remember to <do X> <time>" — is ALWAYS its own set_reminder action, in addition to whatever else is in the message.`,
    ``,
    `Current date/time: ${ctx.nowISO} (timezone ${ctx.timezone}). Resolve every relative date ("friday"/"viernes", "in 3 days"/"en 3 días", "the 19th"/"el 19", "tomorrow"/"mañana") to a concrete value in that timezone. Reminders default to 9:00 AM local.`,
    ``,
    `Existing clients (fuzzy-match against these before creating a new one; ask which one if ambiguous):`,
    clientList,
    ``,
    `NORMALIZE to canonical values:`,
    `- amount: numeric only (\$1.2k -> 1200, "five hundred"/"quinientos" -> 500, "500/mo" -> 500).`,
    `- billing_period enum: one_time | weekly | biweekly | monthly. ("a month"/"al mes" -> monthly, "every other week"/"cada dos semanas" -> biweekly, "one off"/"una vez" -> one_time).`,
    `- status enum: quoted | active | completed | lost. ("said yes"/"dijo que sí"/"are in"/"empieza" -> active; "declined"/"perdimos"/"lost the X job" -> lost; "remove/drop/get rid of/fire/no longer a client/done with X for good"/"quita/elimina/ya no es cliente" -> completed — this DOES remove them, it is a supported action).`,
    `- client_name Title Case; address with standard abbreviations.`,
    `- Work words are service_description, NEVER part of the name: "new quote elena shackelford house painting $3000" = client_name "Elena Shackelford", service_description "house painting", amount 3000. Same for mowing, cleanup, pressure washing, gutters, etc., wherever they appear in the sentence.`,
    `- recurring service schedule: "every other tuesday"/"weekly on mondays"/"cada dos semanas los martes" -> service_interval (weekly|biweekly|monthly) + service_day. This is the SERVICE cadence, separate from billing_period.`,
    `- payments: "collected/paid/cobré" -> log_payment payment_status=paid; "owes"/"hasn't paid"/"debe" -> payment_status=unpaid; "overdue/atrasado" -> overdue.`,
    ``,
    `Intents: log_quote, update_status, log_job, log_payment, set_reminder, query, correction (fixing the last record, e.g. "no it's 333 not 233"), help,`,
    `query = ANY question or request to SEE saved info — "who owes me?", "what's my monday route?", "elena's notes", "need her photos", "send me her pics", "what do I know about bob", "show me her address". SEE/KNOW verbs (show, what's, send, pull up) = query. But SET verbs (add, set, change, update) are NOT query: "add Mitch address" / "set Jane phone" = update_client_info with collect_field (see below), NEVER query.`,
    `log_expense ("spent 84 on mulch at home depot" -> amount + expense_category + description — money OUT, never log_payment). If it's spent FOR a client ("spent 100 on mulch for Elena"), ALSO set client_name so it's saved to their card,`,
    `update_client_info ("angela's number is 555-0142" -> phone; "gate code 4412 at the smiths" -> note_text; "jones referred by bob" -> referred_by; "note for the wilsons: big backyard, steep slope, wants edging" -> note_text; "mitch's address is 5 oak st" -> address — site-visit notes BEFORE any quote are normal, the client may not exist yet). "add Mitch address" / "set Jane phone" / "update the smiths email" with NO value = update_client_info with collect_field set to that field (the app then asks for the value),`,
    `pause_client ("hold jones til spring", "pause the smiths" -> pause_until if a date is given) / resume_client,`,
    `skip_visit ("skip the smiths this week" — one visit only, NOT a schedule change),`,
    `reschedule_visit ("move garcia to friday" -> target_date — one visit only, do NOT change service_day),`,
    `bulk_reschedule ("rained out, push today to tomorrow"/"llovió, muévelo a mañana" -> target_date — every stop due today moves),`,
    `price_change ("smiths are now 350" on an EXISTING client -> amount. NEVER log_quote for an existing active client's new price — that would wrongly restart their quote),`,
    `request_invoice ("invoice bob" -> invoice_kind=invoice; "receipt bob" -> receipt).`,
    ``,
    `CRITICAL guardrails:`,
    `- "finished/done/wrapped up" + work words ("finished mowing at the smiths") = log_job, NOT update_status completed. Only mark completed/lost when the RELATIONSHIP ends ("we're done with the smiths for good", "lost the jones account").`,
    `- "new job/new client <Name> ... $X a week/month" = WON work: log_quote with status="active" (create the client as ACTIVE with amount + billing_period — it is not a pending quote). Only "quoted <name>..." texts are pending quotes. Neither is log_job — log_job is only for work already performed or a dated one-off visit.`,
    `- Use the client name EXACTLY as texted (e.g. "Eric Shackelford" stays Eric) — NEVER substitute a similar known client's name; the app confirms matches itself.`,
    `- One-off future work with a price ("mulch at the smiths next tuesday $450") = log_job with scheduled_on + amount.`,
    `- If they paid by a method ("bob venmoed 300", "paid cash") set payment_method.`,
    `- IMPLICIT NOTES: descriptive details that aren't a field — gate codes, pets, access, terrain, preferences, warnings — go in note_text on the SAME action ("new job Bob Wilson mowing 150/week, big dog in back, gate code 1187" -> log_quote with note_text "big dog in back, gate code 1187"). Never drop these details.`,
    `- Removing/dropping a CLIENT is supported: use update_status completed (see status enum). Only truly unsupported requests (deleting one old job/payment row, editing a past record) get needs_clarification saying what to do instead — never force the nearest intent for those.`,
    `- A bare "no", "fix", "wrong", or "that's not right" (the owner rejecting the last confirmation) = correction intent with correction_text set to their message. NEVER answer these with needs_clarification.`,
    ``,
    `needs_clarification rules — the app chases MISSING FIELDS itself, but you own INTENT ambiguity:`,
    `- NEVER ask about client identity or suggest existing client names ("do you mean X?") — extract the name EXACTLY as texted; the app confirms matches itself.`,
    `- NEVER ask for missing fields (address, phone, price, service) on log_quote or new-client texts — return the action with whatever fields are present; the app chases the rest one question at a time.`,
    `- A question or request to see info is a QUERY, never needs_clarification.`,
    `- DO set needs_clarification when the message is genuinely ambiguous or garbled — you can't tell WHICH thing they want, or it could plausibly mean two different things (e.g. "add Mitch to reminder quote now" — reminder? note? quote?). In that case ask ONE short question ("Want me to set a reminder to quote Mitch, or add a note?") and return NO actions. Never fire two conflicting actions to cover a short unclear message.`,
    `- Set confidence HONESTLY: 0.9+ only when it's clearly one thing; 0.5 or lower when you're unsure. Better to ask than to guess wrong on someone's business.`,
    ``,
    `VOICE — you are ${ctx.ownerName}'s bookkeeper, not software:`,
    `- If you ever write needs_clarification, keep it to ONE short plain-language question. Write it as real text with real line breaks — never the characters backslash-n.`,
    `- NEVER describe yourself as a "parser", "system", "SMS system", "media system", or "software", and never say "I don't have access". You just keep their book.`,
  ].join("\n");
}

export async function parseMessage(text: string, ctx: ParseContext): Promise<ParseOutput> {
  // Explicit language switch shortcut (cheap, no LLM needed).
  const switchTo = detectLanguageSwitch(text);
  if (switchTo) return { result: { actions: [], set_language: switchTo }, usage: null };

  if (config.llmDryRun()) {
    return { result: heuristicParse(text, ctx), usage: null };
  }

  const model = config.anthropic.model();
  const resp = await anthropic().messages.create({
    model,
    max_tokens: 1500,
    system: systemPrompt(ctx),
    tools: [RECORD_TOOL],
    tool_choice: { type: "tool", name: "record_actions" },
    messages: [{ role: "user", content: text }],
  });
  const usage: LlmUsage = { model, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };

  const toolUse = resp.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { result: { actions: [{ intent: "help", confidence: 0 }] }, usage };
  }
  const raw = toolUse.input as { actions?: any[]; needs_clarification?: string; set_language?: Lang };
  const actions = (raw.actions ?? []).map((a) => normalizeAction(a, ctx));
  return {
    result: { actions: actions.length ? actions : [{ intent: "help", confidence: 0 }], needs_clarification: raw.needs_clarification, set_language: raw.set_language },
    usage,
  };
}

/** Compose a short SMS answer to a question, grounded in the provided data snapshot. */
export async function answerQuery(question: string, dataSnapshot: string, ctx: ParseContext, recentConversation?: string): Promise<QueryResult> {
  if (config.llmDryRun()) return { text: heuristicAnswer(dataSnapshot), usage: null };

  const model = config.anthropic.model();
  const langName = ctx.lang === "es" ? "Spanish" : "English";
  const resp = await anthropic().messages.create({
    model,
    max_tokens: 400,
    system: [
      `You are an SMS assistant for ${ctx.ownerName} at ${ctx.businessName}. Answer using ONLY the data below.`,
      `Reply in ${langName}.`,
      ``,
      `FORMAT RULES (it's a text message):`,
      `- Answer ONLY what was asked. Don't volunteer unrelated data (if they ask for notes, give notes — not quotes, balances, and history).`,
      `- Short lines, one fact per line, "•" bullets when listing. No paragraphs, no markdown.`,
      `- Lead with the direct answer. Money like $1,000 · dates like "Fri Jul 10".`,
      `- You are their bookkeeper, not software. NEVER say "system", "SMS system", "data", "database", "records", or "I don't have access". If something isn't saved yet, say it plainly and show how to add it: "Nothing noted for Elena yet — text 'note for Elena: gate code 1187' and I'll keep it." Photos can't be sent by text: "Elena has 2 photos — they're on her card in your dashboard."`,
      `- Be conversational and helpful, like a sharp assistant — not a rigid menu. If they ask what you can do or how to do something, answer plainly: you keep their book by text — log quotes, jobs, payments, reminders, notes, and site photos, and answer questions like "who owes me?" or "what's Monday's route?". Give a quick example they can copy.`,
      `- The dashboard link is in DATA as "DASHBOARD LINK". If they ask how to reach the dashboard, to sign in, or to "send the link", give them that exact URL right now — one line, then how to sign in. NEVER say "I'll send you the link if you need it" or promise to send it later; you can give it immediately. Don't paste the whole examples menu for this.`,
      `- REMEMBER THE LAST FEW TURNS: a terse follow-up ("send it", "send the link", "yes", "what about her") refers to what YOU just offered or discussed in RECENT CONVERSATION. If you just offered the dashboard link and they say "send the link", send the dashboard URL — do not ask "the link to what?".`,
      `- If a request is genuinely unclear AND the recent conversation doesn't resolve it, ask ONE short, friendly clarifying question instead of guessing or dumping the menu (e.g. "Happy to — do you mean Jane Smith or Jane Doe?"). Never invent client facts, amounts, or dates that aren't in the DATA.`,
      `- A name marked "(removed)" is NOT in the book anymore — the owner deleted them. Never present a removed person as a current client. If asked about someone who is only "(removed)", lead with that they were removed (e.g. "Elena was removed from your book.") and only mention their old jobs/payments if the owner explicitly asks for history. Don't surface removed people in general lists.`,
      `- A message that is just a client's name ("Elena") means: tell me about that client. Reply with THAT client's card only (status, price, service, address, anything owed). NEVER answer a bare name with the whole book or a full business rundown.`,
      ``,
      `The RECENT CONVERSATION below is context — a terse follow-up ("images?", "and her address?", "what about bob") refers to the person/topic just discussed.`,
      ...(recentConversation ? [``, `RECENT CONVERSATION (oldest first):`, recentConversation] : []),
      ``,
      `DATA:`,
      dataSnapshot,
    ].join("\n"),
    messages: [{ role: "user", content: question }],
  });
  const usage: LlmUsage = { model, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
  const textBlock = resp.content.find((b) => b.type === "text");
  return { text: textBlock && textBlock.type === "text" ? textBlock.text.trim() : "—", usage };
}

// ──────────────────────────────────────────────────────────────────────────────
// Heuristic fallback parser (no Anthropic key / LLM_DRY_RUN). Handles EN + ES +
// Spanglish well enough to run and test the full loop offline. Outputs RAW fields;
// normalizeAction() does the cleaning, so this stays simple.
// ──────────────────────────────────────────────────────────────────────────────

export function heuristicParse(text: string, ctx: ParseContext): ParseResult {
  const clauses = splitClauses(text);
  const actions: ParsedAction[] = [];
  for (const clause of clauses) {
    const raw = parseClause(clause, ctx);
    if (raw) actions.push(normalizeAction(raw, ctx));
  }
  if (actions.length === 0) actions.push({ intent: "help", confidence: 0.2 });
  return { actions };
}

const CONJUNCTION =
  /\b(?:and|then|also|y|luego|tambi[eé]n)\s+(?=(?:(?:they|he|she|i|we|it)\s+)?(?:remind|remember|recu[eé]rda|set a reminder|quote|quoted|quoting|coti[a-zà-ÿ]*|mark|update|collect|collected|got|gave|paid|owes?|cobr[eé]|recib[ií]|pag|mow|cut|trim|clean|cort[eé]|pod[eé]|limpi[eé]|hice|did|need|don'?t)\b)/i;
const OBLIGATION = /\b((?:need|needs|have|has|got)\s+to\s+.+|gotta\s+.+|don'?t\s+forget\s+.+|remember\s+to\s+.+|remind\s+me\s+.+)$/i;
const HAS_TIME = /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|in \d+ days?|ma[ñn]ana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]xima semana|en \d+ d[ií]as?)\b/i;
function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(CONJUNCTION)) {
    // Peel a trailing obligation ("...need to send quote tomorrow") into its own
    // clause so it becomes a reminder alongside whatever came before it.
    const m = part.match(new RegExp(`^(.*?[a-z0-9])[\\s,]+${OBLIGATION.source}`, "i"));
    if (m && HAS_TIME.test(m[2]) && m[1].trim().length > 2) {
      out.push(m[1].trim(), m[2].trim());
    } else {
      out.push(part.trim());
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function isQuestion(t: string): boolean {
  return (
    /\?/.test(t) ||
    /^(who|what|when|where|which|how|do i|am i|is |are |any |qu[ieé]|cu[aá]l|cu[aá]nto|cu[aá]ndo|d[oó]nde|qu[eé]|tengo|hay )/i.test(t.trim()) ||
    /\b(mrr|recurring revenue|revenue|how much|how many|ingreso|ingresos|cu[aá]nto gano)\b/i.test(t) ||
    // "need her photos", "send me elena's notes", "show me bob's history"
    /\b(need|show|send|see|view|pull up|get me|give me|list|what about)\b.*\b(photos?|pics?|pictures?|images?|notes?|history|balance|address|phone|schedule|info)\b/i.test(t) ||
    /^(photos?|pics?|pictures?|images?|notes?)\??$/i.test(t.trim()) ||
    // possessive/standalone info nouns: "elena's notes", "bob notes", "her photos"
    /\b(photos?|pics?|pictures?|images?|notes?|balance|history)\s*\??$/i.test(t.trim())
  );
}

function parseClause(text: string, _ctx: ParseContext): Record<string, any> | null {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (!t) return null;

  // Correction — including a bare "no"/"fix" rejecting the last confirmation
  if (/^(no|fix|wrong|mal)[.!]?$/i.test(lower) || /^(no[, ]|actually\b|change\b|it'?s .* not |no es|corrige|cambia\b|en realidad|fix\b)/i.test(lower)) {
    return { intent: "correction", confidence: 0.6, correction_text: t };
  }

  // Rainout / bulk reschedule ("rained out, push today to friday")
  if (/\b(rained? out|rain(ed)?\b.*\b(out|day)|llovi[oó]|lluvia|push (today|everything))\b/i.test(lower)) {
    // Only the destination resolves ("...to friday") — never the word "today" itself.
    const toM = t.match(/\b(?:to|a|al|hasta|para)\s+([a-zà-ÿ0-9 ]+)$/i);
    return { intent: "bulk_reschedule", confidence: 0.6, target_date: toM?.[1] ?? "tomorrow" };
  }

  // Pause / resume ("hold jones til spring", "pause the smiths until april", "resume jones")
  const pauseM = t.match(/\b(?:pause|hold|pausa(?:r)?)\s+(?:the |los |las |el |la |a )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)(?:\s+(?:until|til|till|hasta)\s+(.+))?$/i);
  if (pauseM) return { intent: "pause_client", confidence: 0.6, client_name: cleanName(pauseM[1]), pause_until: pauseM[2] };
  const resumeM = t.match(/\b(?:resume|unpause|restart|reactiva(?:r)?)\s+(?:the |los |las |el |la |a )?([a-zà-ÿ][a-zà-ÿ .'’-]+)/i);
  if (resumeM) return { intent: "resume_client", confidence: 0.6, client_name: cleanName(resumeM[1]) };

  // Skip one visit ("skip the smiths this week")
  const skipM = t.match(/\b(?:skip|salta(?:r)?)\s+(?:the |los |las |el |la |a )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)(?:\s+(?:this week|esta semana|today|hoy))?$/i);
  if (skipM) return { intent: "skip_visit", confidence: 0.6, client_name: cleanName(skipM[1]) };

  // Move one visit ("move garcia to friday")
  const moveM = t.match(/\b(?:move|mueve|cambia)\s+(?:the |los |las |el |la |a )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:to|a|al|para el?)\s+(.+)$/i);
  if (moveM && normalizeWeekday(moveM[2])) {
    return { intent: "reschedule_visit", confidence: 0.6, client_name: cleanName(moveM[1]), target_date: moveM[2] };
  }

  // Expense — money OUT ("spent 84 on mulch", "gassed up the truck 65", "bought a blade 45")
  if (/\b(spent|gast[eé]|bought|compr[eé]|gassed up|gassed|filled up|fill up|fuel|paid the (?:supplier|dump|crew))\b/i.test(lower)) {
    // "...for Elena" ties the expense to a client. Peel it off before the description.
    let body = t;
    let client_name: string | undefined;
    const forM = body.match(/\s+\bfor\s+(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s*$/i);
    if (forM) { client_name = cleanName(forM[1]); body = body.slice(0, forM.index).trim(); }
    const desc = body.replace(/^.*?\b(?:spent|gast[eé]|bought|compr[eé]|gassed up|gassed|filled up|fill up|on)\b\s*/i, "").replace(/^\$?[\d.,]+\s*(?:on|en|de|for)?\s*/i, "");
    return { intent: "log_expense", confidence: 0.6, amount: t, expense_category: t, note_text: desc, client_name };
  }

  // "add Mitch address" / "set Jane phone" — SET a field with no value yet; ask for it.
  const collectM = t.match(/^(?:add|set|update|change|edit|put in)\s+(.+?)(?:'s|s')?\s+(address|phone|number|cell|e-?mail|note)s?\.?\s*$/i);
  if (collectM) {
    const f = collectM[2].toLowerCase();
    const field = /phone|number|cell/.test(f) ? "phone" : /mail/.test(f) ? "email" : /note/.test(f) ? "note" : "address";
    return { intent: "update_client_info", confidence: 0.72, client_name: cleanName(collectM[1]), collect_field: field as "address" | "phone" | "email" | "note" };
  }
  // "add Mitch address 5 oak st" / "set the smiths address to 5 oak" — SET with a value.
  const addrSetM = t.match(/^(?:add|set|update|change)\s+(.+?)(?:'s)?\s+address\s+(?:is\s+|to\s+|at\s+)?(.+)$/i);
  if (addrSetM && /\d/.test(addrSetM[2])) return { intent: "update_client_info", confidence: 0.68, client_name: cleanName(addrSetM[1]), address: addrSetM[2].trim() };

  // Site notes ("note for the wilsons: big backyard" — colon OR just a trailing phrase)
  const noteM = t.match(/^notes?\s+(?:for|on|about)?\s*(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s*[:,-]\s*(.+)$/i);
  if (noteM) return { intent: "update_client_info", confidence: 0.65, client_name: cleanName(noteM[1]), note_text: noteM[2].trim() };
  const noteM2 = t.match(/^notes?\s+(?:for|on|about)\s+(?:the |los |las |el |la )?([a-zà-ÿ']+)\s+(.+)$/i);
  if (noteM2 && !/\b(number|phone|cell|referred)\b/i.test(t)) return { intent: "update_client_info", confidence: 0.6, client_name: cleanName(noteM2[1]), note_text: noteM2[2].trim() };

  // Client info ("angela's number is 555-0142", "gate code 4412 at the smiths", "jones referred by bob")
  const phoneM = t.match(/^(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)(?:'s)?\s+(?:number|phone|cell|tel[eé]fono)\s+(?:is|es)?\s*([+()\d][\d\s().-]{6,})/i);
  if (phoneM) return { intent: "update_client_info", confidence: 0.65, client_name: cleanName(phoneM[1]), phone: phoneM[2].trim() };
  const gateM = t.match(/\b(gate code|door code|c[oó]digo)\b.*?\b(?:at|for|de)\s+(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+)/i);
  if (gateM) return { intent: "update_client_info", confidence: 0.6, client_name: cleanName(gateM[2]), note_text: t };
  const refM = t.match(/^(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:referred by|was referred by|refirid[oa] por|la refiri[oó])\s+(.+)$/i);
  if (refM) return { intent: "update_client_info", confidence: 0.6, client_name: cleanName(refM[1]), referred_by: cleanName(refM[2]) };

  // Invoice / receipt ("invoice bob", "receipt for the smiths")
  const invM = t.match(/^(invoice|receipt|factura|recibo)\s+(?:for |para |de )?(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+)$/i);
  if (invM) {
    const kind = /receipt|recibo/i.test(invM[1]) ? "receipt" : "invoice";
    return { intent: "request_invoice", confidence: 0.65, invoice_kind: kind, client_name: cleanName(invM[2]) };
  }

  // Price change ("smiths are now 350", "smiths now 350/mo")
  const priceChangeM = t.match(/^(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:is|are|es|son)?\s*(?:now|ahora)\s+\$?([\d.,]+)/i);
  if (priceChangeM) return { intent: "price_change", confidence: 0.6, client_name: cleanName(priceChangeM[1]), amount: priceChangeM[2], billing_period: t };

  // Question -> query (unless it's a reminder)
  if (isQuestion(t) && !/\b(remind me|recu[eé]rda)/i.test(lower)) {
    return { intent: "query", confidence: 0.6, query_text: t };
  }

  // "(need to) send/prep/write a quote for/to <Name>" — a prospect to be quoted
  // LATER (no amount yet). Create them so their contact info gets collected and
  // the conversation stays open; the amount comes when the quote is actually sent.
  const toQuoteM =
    // "send/prep a quote for/to <Name>"
    t.match(/\b(?:send|sending|prep(?:are)?|write|writing|do|doing|make|making|get)\s+(?:out\s+)?(?:a\s+|the\s+)?quote\s+(?:for|to)\s+(?:the |los |las |el |la |a )?([a-zà-ÿ][a-zà-ÿ .'’-]+)/i)
    // "send/give <Name> a quote" (name-first word order)
    || t.match(/\b(?:send|give|get)\s+(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:a\s+|the\s+|an\s+)?quote\b/i);
  const hasAmount = /\$\s?\d|\b\d+\s*(?:a |per |al |por |\/)?\s*(?:months?|weeks?|mo|wk|mes|semanas?|sem)\b/i.test(lower);
  if (toQuoteM && !hasAmount) {
    // Trim a trailing time phrase off the name ("...for Jane tomorrow").
    const name = cleanName(toQuoteM[1].replace(/\s+\b(tomorrow|today|tonight|next week|on \w+|this \w+|by \w+|ma[ñn]ana|hoy)\b.*$/i, "").trim());
    if (name) return { intent: "log_quote", confidence: 0.6, client_name: name, awaiting_quote: true };
  }

  // "New reminder for elena send later today" — client + task + time in one line.
  const newRemM = t.match(/^new reminder\s+for\s+(.+?)\s+(send|call|text|email|check|pay|invoice|follow(?:\s+up)?)\b(.*)$/i);
  if (newRemM) {
    return {
      intent: "set_reminder", confidence: 0.65,
      client_name: cleanName(newRemM[1]),
      reminder_text: `${newRemM[2]}${newRemM[3]}`.trim(),
      due_at: t,
    };
  }

  // Reminder — incl. obligations ("need to send quote tomorrow") when a time is present
  const isObligation = /\b(need|needs|have|has|got)\s+to\b|gotta|don'?t\s+forget/i.test(lower) && HAS_TIME.test(lower);
  if (/\b(remind me|remember to|new reminder|follow up with|ping me|don'?t let me forget|dont let me forget|recu[eé]rdame|recordarme|dar seguimiento)/i.test(lower) || isObligation) {
    let body = t
      // \b after "to" so "remind me tomorrow ..." doesn't become "morrow ..."
      .replace(/^.*?(remind me to\b|remind me|remember to\b|ping me about|ping me to\b|ping me|don'?t let me forget to\b|don'?t let me forget|recu[eé]rdame que|recu[eé]rdame|recordarme|need to\b|needs to\b|have to\b|has to\b|got to\b|gotta|don'?t forget to\b|don'?t forget)\s*/i, "")
      .replace(/^.*?(follow up with|dar seguimiento a)/i, (m) => m);
    // A LEADING time word ("tomorrow to quote mitch") is the WHEN, not the task.
    body = body.replace(/^\s*(?:today|tomorrow|tonight|ma[ñn]ana|hoy|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b[,\s]*(?:to\s+|que\s+)?/i, "");
    body = body.replace(/\b(today|tomorrow|next week|in \d+ days?|on \w+|this \w+|el \w+|ma[ñn]ana|hoy|pr[oó]xima semana|en \d+ d[ií]as?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "").trim();
    return { intent: "set_reminder", confidence: 0.6, reminder_text: body || t, due_at: t };
  }

  // Payment (incl. owes / unpaid, "gave me", "got X from Y"). ASCII terms use \b;
  // accented ES terms (pagó, cobré, recibí) can't (ó/é aren't word chars).
  const isPayment = /\b(collected|got paid|paid|payment|received|venmo(ed|'d)?|zelled?|owe|owes|unpaid|overdue|gave me)\b/i.test(lower)
    || /(cobr[eé]|recib[ií]|me pag|pag(?:[oó]|aron|an|amos)|deben|atrasad)/i.test(lower)
    || (/\bgot\b/i.test(lower) && /\bfrom\b/i.test(lower) && /\d/.test(lower));
  if (isPayment) {
    const fromM = t.match(/\b(?:from|de|cobr[eé] a)\s+(?:los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+)/i);
    const owesM = t.match(/^([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:owes?|still owes|deben?|no ha pagado|hasn'?t paid|gave me)/i);
    // Leading-name form: "the smiths paid 200", "bob venmoed 300", "García pagó 150", "los smith pagaron 200"
    const leadM = t.match(/^(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:paid|pag(?:[oó]|aron|an|amos)|venmo(?:ed|'d)?|zelled|gave)(?=\s|\d|$)/i);
    const name = fromM?.[1] ?? owesM?.[1] ?? (leadM && !/^(got|collected|received|me|i)$/i.test(leadM[1].trim()) ? (t.match(/^the /i) ? `the ${leadM[1]}` : leadM[1]) : undefined);
    return { intent: "log_payment", confidence: 0.6, amount: t, client_name: cleanName(name), paid_on: t, payment_status: t, payment_method: t };
  }

  // Quote — incl. alt phrasings ("gave X a price of Y", "bid X at Y", "estimate for X")
  if (/\b(quote|quoted|quoting|coti[a-zà-ÿ]*)/i.test(lower)) {
    return { ...parseQuote(t), ...extractSchedule(t), intent: "log_quote", confidence: 0.6 };
  }
  const altQuote = canonicalizeQuote(t);
  if (altQuote) {
    return { ...parseQuoteBody(altQuote), ...extractSchedule(t), intent: "log_quote", confidence: 0.6 };
  }
  const newJobM = t.match(/^new (?:job|client|account|customer)[:,]?\s+(.+)$/i);
  if (newJobM) {
    // "<name> has/wants <service> for $X a week" — name ends at the verb.
    const verbM = newJobM[1].match(/^(.+?)\s+(?:has|wants|needs|got|gets|tiene|quiere)\b\s*(.*)$/i);
    if (verbM) {
      const service = verbM[2].replace(/\bfor\b.*$/i, "").replace(/^(a|an|un|una)\s+/i, "").trim();
      // "Maria Rivera at 42 maple st has mowing..." — peel the address off the name.
      let namePart = verbM[1];
      let address: string | undefined;
      const atM = namePart.match(/^(.*?)\s+(?:at|en|@)\s+(.+)$/i);
      if (atM) { namePart = atM[1]; address = atM[2].trim(); }
      return {
        intent: "log_quote", confidence: 0.6, status: "active", // "new job" = won work
        client_name: cleanName(namePart),
        address,
        // Only the post-verb part can hold the price — never the house number.
        amount: verbM[2], billing_period: verbM[2],
        service_description: service || undefined,
        ...extractSchedule(t),
      };
    }
    return { ...parseQuote("quoted " + newJobM[1]), ...extractSchedule(t), intent: "log_quote", status: "active", confidence: 0.6 };
  }

  // Status change (plain language) — must not collide with job verbs.
  // Prefix match so inflections count: "mowing", "trimmed", "aerated", "edging".
  const looksJob = /\b(mow|clean|trim|cut|aerat|fertiliz|edg|blew|blow|plant|mulch|weed|prun|hedg|rake|dethatch|scalp|cort|pod|limpi|hice)\w*/i.test(lower) || /\bdid\b/i.test(lower);

  // Explicit removal ("remove bob", "drop the smiths", "get rid of jones",
  // "fire james", "done with the smiths for good"). Ends the relationship =
  // update_status completed. (Guarded by !looksJob so "drop off the mulch" stays a job.)
  if (!looksJob) {
    const removeM =
      t.match(/^(?:please\s+)?(?:remove|delete|drop|get\s+rid\s+of|fire|dump|elimina(?:r)?|quita(?:r)?|saca(?:r)?|borra(?:r)?)\s+(?:the\s+|los\s+|las\s+|el\s+|la\s+|a\s+)?([a-zà-ÿ][a-zà-ÿ .'’-]+)/i)
      || t.match(/\bdone with\s+(?:the\s+|los\s+|las\s+|el\s+|la\s+|a\s+)?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+for good\b/i)
      || t.match(/\b([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:is\s+)?no longer (?:a )?(?:client|customer)\b/i);
    if (removeM) {
      // Trim trailing "from my list", "off the list", "as a client", etc.
      const name = cleanName(removeM[1].replace(/\s+\b(from|off|as|on)\b.*$/i, "").trim());
      if (name) return { intent: "update_status", confidence: 0.6, status: "completed", client_name: name };
    }
  }

  if (!looksJob && /\b(accepted|said yes|says yes|are in|is in|signed|booked|declined|said no|lost|went with|going with|chose (?:someone|another)|someone else|dijo que s[ií]|empieza|perdimos|perd[ií]|rechaz|acept)/i.test(lower)) {
    const nameM = t.match(/^(?:mark\s+|lost the\s+|perdimos (?:el|la|a)\s+)?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\b/i);
    return { intent: "update_status", confidence: 0.55, status: t, client_name: cleanName(nameM?.[1]), ...extractSchedule(t) };
  }

  // Recurring schedule on an existing client ("bob every other tuesday")
  const sched = extractSchedule(t);
  if (!looksJob && sched.service_day) {
    const nameM = t.match(/^([a-zà-ÿ][a-zà-ÿ .'’-]+?)\b/i);
    return { intent: "update_status", confidence: 0.5, client_name: cleanName(nameM?.[1]), ...sched };
  }

  // Job
  if (looksJob) {
    const atM = t.match(/\b(?:at|for|a|en)\s+(?:los |las |el |la )?(.+?)(?:\s+(?:today|yesterday|hoy|ayer|on|el)\b.*)?$/i);
    return { intent: "log_job", confidence: 0.55, job_description: t, client_name: cleanName(atM?.[1]), performed_on: t };
  }

  return { intent: "help", confidence: 0.2 };
}

/** Rewrite alternate quote phrasings into a keyword-stripped body, or null. */
function canonicalizeQuote(t: string): string | null {
  let m;
  // "gave the wilsons a price of 250 a month" -> "the wilsons 250 a month"
  if ((m = t.match(/\bgave\s+(?:the |los |las |el |la )?(.+?)\s+(?:an?\s+)?(?:price|quote|estimate|bid)\s+(?:of\s+)?(.+)/i))) return `${m[1]} ${m[2]}`;
  // "bid the taylor retaining wall at 4000" -> "taylor retaining wall 4000"
  if ((m = t.match(/^\s*bid\s+(?:the |on )?(.+?)\s+(?:at|for)\s+(.+)/i))) return `${m[1]} ${m[2]}`;
  // "estimate for dave 200 monthly mowing" -> "dave 200 monthly mowing"
  if ((m = t.match(/^\s*estimate[d]?\s+(?:for\s+)?(.+)/i))) return m[1];
  // "priced the greens at 180/mo" -> "the greens 180/mo"
  if ((m = t.match(/^\s*priced\s+(?:the |los |las |el |la )?(.+?)\s+(?:at|for)\s+(.+)/i))) return `${m[1]} ${m[2]}`;
  return null;
}

/** Pull name/address/amount/period/service out of a quote clause (EN + ES). */
function parseQuote(text: string): Record<string, any> {
  // Strip the quote keyword and a leading ES preposition ("a", "a los").
  const s = text.replace(/^.*?(quoted|quoting|quote|coti[a-zà-ÿ]*)\s*/i, "").replace(/^(a los|a las|a la|a el|al|a|to)\s+/i, "");
  return parseQuoteBody(s);
}

/** Parse an already-keyword-stripped quote body: "name at addr for $amt service". */
// Work-phrase detector: peels a trailing service ("house painting", "weekly
// mowing") off a captured name so it lands in service_description instead.
const SERVICE_PEEL =
  /\b(?:(?:house|deck|window|gutter|lawn|yard|pool|pressure|power|spring|fall|weekly|monthly)\s+)*(?:paint(?:ing)?|mow(?:ing)?|clean(?:ing|up)?|wash(?:ing)?|landscaping|trim(?:ming)?|mulch(?:ing)?|edging|weeding|hauling|plow(?:ing)?|gutters?|hedges?|fertiliz(?:ing|ation)?|aerat(?:ing|ion)?)\b.*$/i;
function peelService(name?: string): { name?: string; service?: string } {
  if (!name) return { name };
  const m = name.match(SERVICE_PEEL);
  if (!m || m.index == null || m.index === 0) return { name }; // keep at least one name token
  const peeled = name.slice(0, m.index).replace(/[\s,;-]+$/, "").trim();
  if (!peeled) return { name };
  return { name: peeled, service: name.slice(m.index).trim() };
}

function parseQuoteBody(body: string): Record<string, any> {
  let s = body.replace(/^(a los|a las|a la|a el|al|a|to)\s+/i, "");

  // Find the price: a number tied to a period word ("500 a month", "$500/mo", "$500 al mes"),
  // or — for one-time quotes — a $-prefixed amount with no period ("$350 for cleanup").
  const priceRe = /(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:a |per |al |por |\/)?\s*(months?|weeks?|mo|wk|mes(?:es)?|semanas?|sem)\b/i;
  const oneTimeRe = /(\$\s*[0-9][0-9,]*(?:\.[0-9]+)?)/;
  let price = s.match(priceRe);
  let oneTime = false;
  if (!price) {
    price = s.match(oneTimeRe);
    oneTime = !!price;
  }
  const amount = price ? price[1] : undefined;

  let name: string | undefined, address: string | undefined, service: string | undefined;
  if (price && price.index != null) {
    const before = s.slice(0, price.index).trim();
    const after = s.slice(price.index + price[0].length).trim();
    // name = leading words before the first number / preposition; rest = address
    const split = before.match(/^([a-zà-ÿ][a-zà-ÿ .'’-]*?)(?=\s+(?:\d|at\b|en\b|for\b|por\b|@))/i);
    if (split) {
      name = split[1];
      address = before
        .slice(split[1].length)
        .replace(/^\s*(?:at|en|for|por|@)\s+/i, "")     // leading preposition
        .replace(/\s+(?:for|por|en|at)\b.*$/i, "")       // trailing preposition + junk
        .replace(/[^a-z0-9]+$/i, "")                      // stray trailing punctuation
        .trim();
    } else {
      name = before;
    }
    service = after;
    // "elena shackelford house painting $3000": the work phrase rides inside the
    // name when there's no address; peel it into the service.
    if (!service) {
      const peeled = peelService(name);
      name = peeled.name;
      service = peeled.service ?? service;
    }
  } else {
    // No price in the text — still split "name at address for service".
    const atM = s.match(/^(.*?)\s+(?:at|en|@)\s+(.+)$/i);
    if (atM) {
      name = atM[1];
      const rest = atM[2].split(/\s+(?:for|por)\s+/i);
      address = rest[0].replace(/[^a-z0-9]+$/i, "").trim();
      service = rest.slice(1).join(" ") || undefined;
    } else {
      const forM = s.match(/^(.*?)\s+(?:for|por)\s+(.+)$/i);
      if (forM) {
        name = forM[1];
        service = forM[2];
      } else {
        const peeled = peelService(s);
        name = peeled.name;
        service = peeled.service;
      }
    }
  }
  return {
    client_name: cleanName(name),
    address: address || undefined,
    amount,
    billing_period: oneTime ? "one_time" : body,
    service_description: service || undefined,
  };
}

function cleanName(s?: string): string | undefined {
  if (!s) return undefined;
  const n = s.trim().replace(/[.,]+$/, "");
  return n || undefined;
}

/** Pull a recurring service schedule when a weekday is present (heuristic-safe). */
function extractSchedule(text: string): { service_interval?: string; service_day?: string } {
  const day = normalizeWeekday(text);
  if (!day) return {};
  const t = text.toLowerCase();
  const interval = /(every other|bi-?weekly|cada dos|quincenal)/.test(t)
    ? "biweekly"
    : /(month|mensual)/.test(t)
    ? "monthly"
    : "weekly";
  return { service_interval: interval, service_day: day };
}

function heuristicAnswer(dataSnapshot: string): string {
  return dataSnapshot.trim() || "—";
}

export type { Intent };
