export type ClientStatus = "quoted" | "active" | "completed" | "lost" | "paused";
export type MessageDirection = "inbound" | "outbound";
export type ReminderStatus = "pending" | "sent" | "done" | "cancelled";
// Canonical billing periods (stored in clients.billing_period). Always normalized.
export type BillingPeriod = "one_time" | "weekly" | "biweekly" | "monthly";
export type ServiceInterval = "weekly" | "biweekly" | "monthly";
export type PaymentStatus = "paid" | "unpaid" | "overdue";
export type Lang = "en" | "es";

export interface BusinessSettings {
  followup_days?: number;
  digest_enabled?: boolean;
  digest_hour?: number;
  last_digest_date?: string; // YYYY-MM-DD, set by the cron after sending
  billing_enabled?: boolean; // log usage/cost (default true; turn off to disable)
  quote_reminder_days?: number[]; // auto quote-follow-up cadence, default [2,5,7,14]
  language?: Lang; // operator's language for UI + outbound texts (default en)
  payment_note?: string; // shown on invoices, e.g. "Venmo @shacks-landing · Zelle 971-..."
  weekly_digest_enabled?: boolean; // Monday money digest (default ON)
  last_weekly_digest_date?: string; // YYYY-MM-DD guard
  last_monthly_summary?: string; // YYYY-MM guard
  last_season_nudge?: string; // YYYY-MM guard (Feb/Sep booking nudges)
  referral_code?: string; // keyword for "text CODE to join" referral line
  city?: string; // display label for the forecast location ("Portland, Oregon")
  lat?: number; // geocoded once when the city is set
  lon?: number;
}

/** Conversation memory: the pending question the next inbound text may answer. */
export interface PendingState {
  kind: "which_client" | "confirm_create" | "missing_amount" | "confirm_match" | "complete_client" | "attach_photo";
  action: ParsedAction; // the action to run once resolved
  candidateIds?: string[]; // which_client choices in order / confirm_match's single candidate
  missing?: string[]; // complete_client: which fields we're still chasing ("name"|"address"|"phone")
  media?: { url: string; contentType?: string }[]; // attach_photo: the photos waiting for a client
  expiresAt: string; // ISO; stale questions are ignored
}

export interface Attachment {
  id: string;
  business_id: string;
  client_id: string | null;
  storage_path: string;
  content_type: string | null;
  caption: string | null;
  created_at: string;
}

export type ReminderKind = "manual" | "quote_followup";

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface BillingEvent {
  id: string;
  business_id: string;
  event_type: "sms_inbound" | "sms_outbound" | "llm_parse" | "llm_query";
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  sms_segments: number | null;
  cost_usd: number;
  message_id: string | null;
  created_at: string;
}

export interface Business {
  id: string;
  slug: string;
  name: string;
  owner_name: string;
  timezone: string;
  settings: BusinessSettings;
  created_at: string;
}

export interface AuthorizedPhone {
  id: string;
  business_id: string;
  phone: string;
  label: string | null;
  is_primary: boolean;
  opted_out: boolean;
  language: Lang | null; // per-phone override (ES crew, EN owner)
  pending_state: PendingState | null; // conversation memory
  created_at: string;
}

export interface Client {
  id: string;
  business_id: string;
  name: string;
  address: string | null;
  status: ClientStatus;
  service_description: string | null;
  amount: number | null;
  billing_period: string | null;
  notes: string | null;
  last_nudged_at: string | null;
  // black book: recurring service schedule
  service_interval: string | null; // weekly | biweekly | monthly
  service_day: string | null; // lowercase english day, e.g. "tuesday"
  next_service_on: string | null; // YYYY-MM-DD
  // contact + referral + seasonal pause
  phone: string | null;
  email: string | null;
  referred_by: string | null;
  paused_until: string | null; // YYYY-MM-DD
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  business_id: string;
  client_id: string | null;
  description: string;
  performed_on: string | null;
  scheduled_on: string | null; // YYYY-MM-DD for future one-offs
  amount: number | null; // one-off job price -> becomes a charge when done
  status: "scheduled" | "done";
  created_at: string;
}

export interface Payment {
  id: string;
  business_id: string;
  client_id: string | null;
  amount: number;
  paid_on: string | null;
  status: PaymentStatus;
  method: string | null; // cash | check | venmo | zelle | other
  created_at: string;
}

export type ChargeStatus = "open" | "partial" | "paid" | "void";
export type ChargeKind = "cycle" | "manual" | "job";

/** A receivable: money the operator is OWED (auto per billing cycle, "owes", or a priced job). */
export interface Charge {
  id: string;
  business_id: string;
  client_id: string | null;
  amount: number;
  paid_amount: number;
  status: ChargeStatus;
  due_on: string; // YYYY-MM-DD
  description: string | null;
  kind: ChargeKind;
  created_at: string;
}

export interface Expense {
  id: string;
  business_id: string;
  amount: number;
  category: string | null;
  description: string | null;
  spent_on: string; // YYYY-MM-DD
  created_at: string;
}

export interface InvoiceRecord {
  id: string; // uuid == unguessable share token
  business_id: string;
  client_id: string;
  kind: "invoice" | "receipt";
  payload: InvoicePayload;
  created_at: string;
}
export interface InvoicePayload {
  business_name: string;
  client_name: string;
  client_address: string | null;
  lines: { description: string; amount: number; due_on?: string }[];
  total: number;
  payment_note: string | null;
  lang: Lang;
  date: string; // YYYY-MM-DD
}

export interface Reminder {
  id: string;
  business_id: string;
  client_id: string | null;
  text: string;
  due_at: string;
  status: ReminderStatus;
  kind: ReminderKind;
  source_message_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface Message {
  id: string;
  business_id: string;
  direction: MessageDirection;
  from_phone: string | null;
  body: string;
  parsed_intent: string | null;
  parsed_entities: Record<string, unknown> | null;
  external_id: string | null; // provider message id (Twilio MessageSid) for dedup
  created_at: string;
}

// ── LLM parse result ──────────────────────────────────────────────────────────
export type Intent =
  | "log_quote"
  | "update_status"
  | "log_job"
  | "log_payment"
  | "set_reminder"
  | "correction"
  | "query"
  | "help"
  // roadmap intents
  | "log_expense" // "spent 84 on mulch"
  | "update_client_info" // phone/email/referred-by/gate-code notes
  | "pause_client" // "hold jones til spring"
  | "resume_client"
  | "skip_visit" // "skip the smiths this week"
  | "reschedule_visit" // "move garcia to friday"
  | "bulk_reschedule" // "rained out, push today to tomorrow"
  | "price_change" // "smiths are now 350"
  | "request_invoice"; // "invoice bob" / "receipt bob"

/** One action extracted from a message. A single text can produce several. */
export interface ParsedAction {
  intent: Intent;
  confidence: number;
  // entities (all optional; the relevant ones are filled per intent). After the
  // normalization pass these hold CLEAN canonical values (numeric amount, enum
  // period/status, ISO dates, Title-Cased names/addresses).
  client_name?: string;
  address?: string;
  amount?: number;
  billing_period?: BillingPeriod;
  service_description?: string;
  status?: ClientStatus;
  service_interval?: ServiceInterval; // recurring service cadence
  service_day?: string; // preferred day (lowercase english)
  job_description?: string;
  performed_on?: string; // YYYY-MM-DD
  paid_on?: string; // YYYY-MM-DD
  payment_status?: PaymentStatus; // for log_payment
  reminder_text?: string;
  due_at?: string; // ISO 8601
  query_text?: string;
  // free-text correction content (intent === "correction")
  correction_text?: string;
  // roadmap entities
  client_id?: string; // resolved by conversation memory — handlers use it directly
  client_is_new?: boolean; // set when conversation memory just created this client (completeness ask still applies)
  note_text?: string; // update_client_info: gate codes, misc notes
  phone?: string; // update_client_info
  email?: string; // update_client_info
  referred_by?: string; // update_client_info
  expense_category?: string; // log_expense: mulch|fuel|equipment|labor|other
  target_date?: string; // YYYY-MM-DD for reschedule_visit / bulk_reschedule
  pause_until?: string; // YYYY-MM-DD for pause_client (optional)
  invoice_kind?: "invoice" | "receipt"; // request_invoice
  payment_method?: string; // log_payment: cash|check|venmo|zelle|other
  scheduled_on?: string; // YYYY-MM-DD: a FUTURE one-off job ("mulch next tuesday $450")
}

/** A draft client produced by import (text / CSV / photo), reviewed before saving. */
export interface ClientDraft {
  name: string;
  address?: string;
  phone?: string;
  amount?: number;
  billing_period?: BillingPeriod;
  service_description?: string;
  service_interval?: ServiceInterval;
  service_day?: string;
  status?: ClientStatus;
}

/** Result of parsing one inbound message — supports multiple actions. */
export interface ParseResult {
  actions: ParsedAction[];
  /** A short question to text back instead of saving, when something is unclear. */
  needs_clarification?: string;
  /** Operator explicitly asked to switch language (e.g. texted "español"). */
  set_language?: Lang;
}

// Back-compat alias (older imports).
export type ParsedMessage = ParsedAction;
