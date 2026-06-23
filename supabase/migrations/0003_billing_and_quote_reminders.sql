-- ─────────────────────────────────────────────────────────────────────────────
-- 0003 — usage/billing log (toggleable) + automatic quote-reminder sequence
-- ─────────────────────────────────────────────────────────────────────────────

-- ── billing_events ───────────────────────────────────────────────────────────
-- Optional usage/cost log: one row per billable unit (each SMS segment in/out and
-- each LLM call), with an estimated USD cost. Turn off per-business via
-- settings.billing_enabled=false, or globally via env BILLING_ENABLED=false.
create table if not exists billing_events (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  event_type    text not null,            -- sms_inbound | sms_outbound | llm_parse | llm_query
  model         text,                     -- LLM model (for llm_* events)
  input_tokens  int,
  output_tokens int,
  sms_segments  int,
  cost_usd      numeric(10,5) not null default 0,
  message_id    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists billing_events_business_idx on billing_events (business_id, created_at);
alter table billing_events enable row level security;

-- ── quote-reminder sequence ──────────────────────────────────────────────────
-- Reminders now carry a kind. Logging a quote auto-schedules a follow-up sequence
-- (default +2/+5/+7/+14 days, configurable). The sequence is auto-cancelled the
-- moment the client leaves "quoted" status (agreed -> active, declined -> lost).
alter table reminders add column if not exists kind text not null default 'manual';
create index if not exists reminders_kind_idx on reminders (client_id, kind, status);

-- Default the new config knobs on existing businesses (no-op if already present).
update businesses
set settings = settings
  || jsonb_build_object('billing_enabled', coalesce(settings->'billing_enabled', 'true'::jsonb))
  || jsonb_build_object('quote_reminder_days', coalesce(settings->'quote_reminder_days', '[2,5,7,14]'::jsonb));
