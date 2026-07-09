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
    `Return an ARRAY of actions via the record_actions tool — one message can contain several (e.g. a quote AND a reminder).`,
    ``,
    `Current date/time: ${ctx.nowISO} (timezone ${ctx.timezone}). Resolve every relative date ("friday"/"viernes", "in 3 days"/"en 3 días", "the 19th"/"el 19", "tomorrow"/"mañana") to a concrete value in that timezone. Reminders default to 9:00 AM local.`,
    ``,
    `Existing clients (fuzzy-match against these before creating a new one; ask which one if ambiguous):`,
    clientList,
    ``,
    `NORMALIZE to canonical values:`,
    `- amount: numeric only (\$1.2k -> 1200, "five hundred"/"quinientos" -> 500, "500/mo" -> 500).`,
    `- billing_period enum: one_time | weekly | biweekly | monthly. ("a month"/"al mes" -> monthly, "every other week"/"cada dos semanas" -> biweekly, "one off"/"una vez" -> one_time).`,
    `- status enum: quoted | active | completed | lost. ("said yes"/"dijo que sí"/"are in"/"empieza" -> active; "declined"/"perdimos"/"lost the X job" -> lost).`,
    `- client_name Title Case; address with standard abbreviations.`,
    `- recurring service schedule: "every other tuesday"/"weekly on mondays"/"cada dos semanas los martes" -> service_interval (weekly|biweekly|monthly) + service_day. This is the SERVICE cadence, separate from billing_period.`,
    `- payments: "collected/paid/cobré" -> log_payment payment_status=paid; "owes"/"hasn't paid"/"debe" -> payment_status=unpaid; "overdue/atrasado" -> overdue.`,
    ``,
    `Intents: log_quote, update_status, log_job, log_payment, set_reminder, query (questions like "who do I follow up with?"/"who owes me?"/"what's my monday route?"), correction (fixing the last record, e.g. "no it's 333 not 233"), help,`,
    `log_expense ("spent 84 on mulch at home depot" -> amount + expense_category + description — money OUT, never log_payment),`,
    `update_client_info ("angela's number is 555-0142" -> phone; "gate code 4412 at the smiths" -> note_text; "jones referred by bob" -> referred_by; "note for the wilsons: big backyard, steep slope, wants edging" -> note_text — site-visit notes BEFORE any quote are normal, the client may not exist yet),`,
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
    `- Requests you have no intent for (delete a record, edit an old job): set needs_clarification saying what to do instead — never force the nearest intent.`,
    `- A bare "no", "fix", "wrong", or "that's not right" (the owner rejecting the last confirmation) = correction intent with correction_text set to their message. NEVER answer these with needs_clarification.`,
    ``,
    `needs_clarification rules — the app has its own follow-up system, so stay out of its lane:`,
    `- NEVER ask about client identity or suggest existing client names ("do you mean X?") — extract the name EXACTLY as texted; the app confirms matches itself.`,
    `- NEVER ask for missing fields (address, phone, price, service) on log_quote or new-client texts — return the action with whatever fields are present; the app chases the rest one question at a time.`,
    `- needs_clarification is ONLY for a genuinely unreadable intent. When in doubt between asking and returning a partial action, return the partial action.`,
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
export async function answerQuery(question: string, dataSnapshot: string, ctx: ParseContext): Promise<QueryResult> {
  if (config.llmDryRun()) return { text: heuristicAnswer(dataSnapshot), usage: null };

  const model = config.anthropic.model();
  const langName = ctx.lang === "es" ? "Spanish" : "English";
  const resp = await anthropic().messages.create({
    model,
    max_tokens: 400,
    system: [
      `You are an SMS assistant for ${ctx.ownerName} at ${ctx.businessName}. Answer the question using ONLY the data below.`,
      `Reply in ${langName}. Keep it short and natural — it's a text message. No long paragraphs, no markdown.`,
      `If the data doesn't contain the answer, say so briefly.`,
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
  /\b(?:and|then|also|y|luego|tambi[eé]n)\s+(?=(?:remind|remember|recu[eé]rda|set a reminder|quote|quoted|coti[a-zà-ÿ]*|mark|update|collect|collected|got paid|paid|cobr[eé]|recib[ií]|pag|mow|mowed|cut|trim|clean|cleanup|cort[eé]|pod[eé]|limpi[eé]|hice|did)\b)/i;
function splitClauses(text: string): string[] {
  return text.split(CONJUNCTION).map((s) => s.trim()).filter(Boolean);
}

function isQuestion(t: string): boolean {
  return (
    /\?/.test(t) ||
    /^(who|what|when|where|which|how|do i|am i|is |are |any |qu[ieé]|cu[aá]l|cu[aá]nto|cu[aá]ndo|d[oó]nde|qu[eé]|tengo|hay )/i.test(t.trim()) ||
    /\b(mrr|recurring revenue|revenue|how much|how many|ingreso|ingresos|cu[aá]nto gano)\b/i.test(t)
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

  // Expense — money OUT ("spent 84 on mulch at home depot")
  if (/\b(spent|gast[eé]|bought|compr[eé])\b/i.test(lower)) {
    const desc = t.replace(/^.*?\b(?:spent|gast[eé]|bought|compr[eé])\b\s*/i, "").replace(/^\$?[\d.,]+\s*(?:on|en|de)?\s*/i, "");
    return { intent: "log_expense", confidence: 0.6, amount: t, expense_category: t, note_text: desc };
  }

  // Site notes ("note for the wilsons: big backyard, steep slope" — client may not exist yet)
  const noteM = t.match(/^notes?\s+(?:for|on|about)?\s*(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s*[:,-]\s*(.+)$/i);
  if (noteM) return { intent: "update_client_info", confidence: 0.65, client_name: cleanName(noteM[1]), note_text: noteM[2].trim() };

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

  // Reminder
  if (/\b(remind me|remember to|follow up with|recu[eé]rdame|recordarme|dar seguimiento)/i.test(lower)) {
    let body = t
      .replace(/^.*?(remind me to|remind me|remember to|recu[eé]rdame que|recu[eé]rdame|recordarme)\s*/i, "")
      .replace(/^.*?(follow up with|dar seguimiento a)/i, (m) => m);
    body = body.replace(/\b(today|tomorrow|next week|in \d+ days?|on \w+|this \w+|el \w+|ma[ñn]ana|hoy|pr[oó]xima semana|en \d+ d[ií]as?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "").trim();
    return { intent: "set_reminder", confidence: 0.6, reminder_text: body || t, due_at: t };
  }

  // Payment (incl. owes / unpaid)
  if (/\b(collected|got paid|paid|payment|received|venmo(ed|'d)?|zelled?|owe|owes|unpaid|overdue|cobr[eé]|recib[ií]|me pag|pag[oó]|deben?|atrasad)\b/i.test(lower)) {
    const fromM = t.match(/\b(?:from|a|de)\s+(?:los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+)/i);
    const owesM = t.match(/^([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:owes?|still owes|deben?|no ha pagado|hasn'?t paid)/i);
    // Leading-name form: "the smiths paid 200", "bob venmoed 300"
    const leadM = t.match(/^(?:the |los |las |el |la )?([a-zà-ÿ][a-zà-ÿ .'’-]+?)\s+(?:paid|pag[oó]|venmo(?:ed|'d)?|zelled)\b/i);
    const name = fromM?.[1] ?? owesM?.[1] ?? (leadM && !/^(got|collected|received|me)$/i.test(leadM[1].trim()) ? (t.match(/^the /i) ? `the ${leadM[1]}` : leadM[1]) : undefined);
    return { intent: "log_payment", confidence: 0.6, amount: t, client_name: cleanName(name), paid_on: t, payment_status: t, payment_method: t };
  }

  // Quote — incl. "new job/client <name> ... $X a week" (a new engagement, not a work log)
  if (/\b(quote|quoted|coti[a-zà-ÿ]*)/i.test(lower)) {
    return { ...parseQuote(t), ...extractSchedule(t), intent: "log_quote", confidence: 0.6 };
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

  // Status change (plain language) — must not collide with job verbs
  const looksJob = /\b(mowed|mow|cleanup|clean up|trim|cut|aerat|fertiliz|edg|blew|blow|plant|mulch|did|cort[eé]|pod[eé]|limpi[eé]|hice)\b/i.test(lower);
  if (!looksJob && /\b(accepted|said yes|are in|is in|signed|declined|said no|lost|dijo que s[ií]|empieza|perdimos|perd[ií]|rechaz|acept)/i.test(lower)) {
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

/** Pull name/address/amount/period/service out of a quote clause (EN + ES). */
function parseQuote(text: string): Record<string, any> {
  // Strip the quote keyword and a leading ES preposition ("a", "a los").
  let s = text.replace(/^.*?(quoted|quote|coti[a-zà-ÿ]*)\s*/i, "").replace(/^(a los|a las|a la|a el|al|a|to)\s+/i, "");

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
        name = s;
      }
    }
  }
  return {
    client_name: cleanName(name),
    address: address || undefined,
    amount,
    billing_period: oneTime ? "one_time" : text,
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
