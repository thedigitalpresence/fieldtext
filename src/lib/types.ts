export type ClientStatus = "quoted" | "active" | "completed" | "lost";
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
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  business_id: string;
  client_id: string | null;
  description: string;
  performed_on: string | null;
  created_at: string;
}

export interface Payment {
  id: string;
  business_id: string;
  client_id: string | null;
  amount: number;
  paid_on: string | null;
  status: PaymentStatus;
  created_at: string;
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
  | "help";

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
