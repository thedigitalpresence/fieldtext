-- ─────────────────────────────────────────────────────────────────────────────
-- FieldText — initial schema
-- Run in the Supabase SQL editor, or via `supabase db push`.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ── Enums ────────────────────────────────────────────────────────────────────
do $$ begin create type client_status as enum ('quoted','active','completed','lost');
exception when duplicate_object then null; end $$;

do $$ begin create type message_direction as enum ('inbound','outbound');
exception when duplicate_object then null; end $$;

do $$ begin create type reminder_status as enum ('pending','sent','done','cancelled');
exception when duplicate_object then null; end $$;

-- ── businesses ───────────────────────────────────────────────────────────────
-- One row per landscaping business. Single-tenant MVP uses one row; multi-tenant
-- ready — add a row + authorized phones to onboard another business, no code change.
create table if not exists businesses (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  owner_name  text not null,
  timezone    text not null default 'America/New_York',
  settings    jsonb not null default '{}'::jsonb,  -- followup_days, digest_enabled, digest_hour, ...
  created_at  timestamptz not null default now()
);

-- ── authorized_phones ────────────────────────────────────────────────────────
-- Only these numbers may write/query via SMS. Anything else is ignored.
create table if not exists authorized_phones (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  phone        text not null,                 -- E.164
  label        text,
  is_primary   boolean not null default false, -- receives reminders / nudges / digest
  created_at   timestamptz not null default now(),
  unique (phone)
);
create index if not exists authorized_phones_business_idx on authorized_phones (business_id);

-- ── clients ──────────────────────────────────────────────────────────────────
create table if not exists clients (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  name                text not null,
  address             text,
  status              client_status not null default 'quoted',
  service_description text,
  amount              numeric(10,2),
  billing_period      text,                    -- one-time | weekly | monthly | yearly
  notes               text,
  last_nudged_at      timestamptz,             -- for auto follow-up nudges
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists clients_business_idx on clients (business_id);
create index if not exists clients_status_idx on clients (business_id, status);

-- ── jobs ─────────────────────────────────────────────────────────────────────
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  client_id     uuid references clients(id) on delete set null,
  description   text not null,
  performed_on  date,
  created_at    timestamptz not null default now()
);
create index if not exists jobs_business_idx on jobs (business_id);

-- ── payments ─────────────────────────────────────────────────────────────────
create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  client_id     uuid references clients(id) on delete set null,
  amount        numeric(10,2) not null,
  paid_on       date,
  created_at    timestamptz not null default now()
);
create index if not exists payments_business_idx on payments (business_id);

-- ── reminders ────────────────────────────────────────────────────────────────
-- Persisted so the schedule survives serverless restarts; the cron sends what's due.
create table if not exists reminders (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,
  client_id          uuid references clients(id) on delete set null,
  text               text not null,
  due_at             timestamptz not null,
  status             reminder_status not null default 'pending',
  source_message_id  uuid,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz
);
create index if not exists reminders_due_idx on reminders (status, due_at);
create index if not exists reminders_business_idx on reminders (business_id);

-- ── messages ─────────────────────────────────────────────────────────────────
-- Full audit log of every inbound text + the parse + every outbound reply.
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  direction        message_direction not null,
  from_phone       text,
  body             text not null,
  parsed_intent    text,
  parsed_entities  jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists messages_business_idx on messages (business_id, created_at);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- All access goes through the server with the service-role key (bypasses RLS).
-- Enabling RLS with no policies means the public/anon key can never read this
-- business's data even if it leaks. A business can only ever see its own rows.
alter table businesses        enable row level security;
alter table authorized_phones enable row level security;
alter table clients           enable row level security;
alter table jobs              enable row level security;
alter table payments          enable row level security;
alter table reminders         enable row level security;
alter table messages          enable row level security;


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the single MVP business + the owner's authorized phone.
-- EDIT these values for your real business before going live.
-- ─────────────────────────────────────────────────────────────────────────────

insert into businesses (slug, name, owner_name, timezone, settings)
values (
  'green-acres',                       -- TODO: matches DEFAULT_BUSINESS_SLUG
  'Green Acres Landscaping',           -- TODO: real business name
  'Mike',                              -- TODO: real owner first name
  'America/Los_Angeles',               -- TODO: set your timezone (530 area code → Pacific)
  jsonb_build_object(
    'followup_days', 3,                -- (legacy) nudge window
    'digest_enabled', false,           -- optional morning digest
    'digest_hour', 7,                  -- local hour (0-23) to send the digest
    'billing_enabled', false,          -- usage/cost logging off by default (set true to enable)
    'quote_reminder_days', jsonb_build_array(2, 5, 7, 14),  -- auto quote follow-up cadence
    'language', 'en'                   -- operator language for UI + outbound texts (en | es)
  )
)
on conflict (slug) do nothing;

-- The owner's REAL cell. Only authorized numbers may text the system, and the
-- primary one receives reminders, nudges, and the optional digest.
insert into authorized_phones (business_id, phone, label, is_primary)
select id, '+15306056728', 'Owner cell', true    -- your cell (authorized + reminder recipient)
from businesses where slug = 'green-acres'
on conflict (phone) do nothing;


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


-- ─────────────────────────────────────────────────────────────────────────────
-- 0004 — production hardening: idempotent webhooks + STOP/opt-out compliance
-- ─────────────────────────────────────────────────────────────────────────────

-- Store Twilio's MessageSid so a retried webhook can't double-process a text.
alter table messages add column if not exists external_id text;
create index if not exists messages_external_idx on messages (business_id, external_id);

-- A2P compliance: honor STOP even on an owner-facing line. When set, we never
-- text this number (reminders, nudges, confirmations) until they reply START.
alter table authorized_phones add column if not exists opted_out boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0005 — black book: recurring service schedule + payment status
-- ─────────────────────────────────────────────────────────────────────────────
alter table clients add column if not exists service_interval text;
alter table clients add column if not exists service_day text;
alter table clients add column if not exists next_service_on date;
create index if not exists clients_next_service_idx on clients (business_id, next_service_on);
alter table payments add column if not exists status text not null default 'paid';
create index if not exists payments_status_idx on payments (business_id, status);
-- 0006_roadmap.sql — the "book that balances" migration.
-- Receivables (charges), expenses, signups, invoice links, client contact info,
-- paused status, scheduled one-off jobs, per-phone language + conversation memory.
-- Run AFTER 0001–0005. Safe to re-run (everything is IF NOT EXISTS / idempotent).

-- Paused clients (winter/seasonal hold without destroying the record).
-- NOTE: run this statement by itself if your editor wraps in a transaction.
alter type client_status add value if not exists 'paused';

-- Clients: contact info, referral source, pause window.
alter table clients add column if not exists phone text;
alter table clients add column if not exists email text;
alter table clients add column if not exists referred_by text;
alter table clients add column if not exists paused_until date;

-- Authorized phones: per-phone language (ES crew / EN owner) + conversation
-- memory so answers to "Which one?" resolve against the pending question.
alter table authorized_phones add column if not exists language text;
alter table authorized_phones add column if not exists pending_state jsonb;

-- Jobs: schedulable one-offs with a price ("mulch next tuesday $450").
alter table jobs add column if not exists scheduled_on date;
alter table jobs add column if not exists amount numeric(10,2);
alter table jobs add column if not exists status text not null default 'done'; -- scheduled | done

-- Payments: how the money arrived (cash / check / venmo / zelle / other).
alter table payments add column if not exists method text;

-- ── Receivables: what the operator is OWED ────────────────────────────────────
-- 'cycle'  = auto-generated from an active client's amount + billing period
-- 'manual' = "bob owes 300"
-- 'job'    = a priced one-off job marked done
create table if not exists charges (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  client_id    uuid references clients(id) on delete set null,
  amount       numeric(10,2) not null,
  paid_amount  numeric(10,2) not null default 0,
  status       text not null default 'open',   -- open | partial | paid | void
  due_on       date not null,
  description  text,
  kind         text not null default 'cycle',  -- cycle | manual | job
  created_at   timestamptz not null default now()
);
create unique index if not exists charges_cycle_uniq on charges (client_id, due_on) where kind = 'cycle';
create index if not exists charges_open_idx on charges (business_id, status);

-- ── Expenses ("spent 84 on mulch at home depot") ──────────────────────────────
create table if not exists expenses (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  amount       numeric(10,2) not null,
  category     text,
  description  text,
  spent_on     date not null default current_date,
  created_at   timestamptz not null default now()
);
create index if not exists expenses_biz_idx on expenses (business_id, spent_on);

-- ── Signups: the funnel finally saves the lead + proof of consent ─────────────
create table if not exists signups (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  business_name text,
  phone         text,
  consent_text  text,
  consented_at  timestamptz not null default now(),
  ip            text,
  created_at    timestamptz not null default now()
);

-- ── Invoice / receipt forward-links ("invoice bob" → shareable page) ──────────
-- payload freezes the line items at creation; the uuid IS the unguessable token.
create table if not exists invoices (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  client_id    uuid not null references clients(id) on delete cascade,
  kind         text not null default 'invoice', -- invoice | receipt
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

-- RLS on (service-role only, same posture as every other table: no policies).
alter table charges  enable row level security;
alter table expenses enable row level security;
alter table signups  enable row level security;
alter table invoices enable row level security;
-- 0007_notes_photos.sql — site photos attached to clients (notes already exist).
-- Photos texted to the number are copied into Supabase Storage (bucket
-- "attachments", created automatically on first upload) and indexed here.

create table if not exists attachments (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  client_id    uuid references clients(id) on delete cascade,
  storage_path text not null,          -- path in the "attachments" bucket
  content_type text,
  caption      text,
  created_at   timestamptz not null default now()
);
create index if not exists attachments_client_idx on attachments (business_id, client_id);

alter table attachments enable row level security;
-- 0008_multitenant.sql — per-business dashboard login.
-- Each business gets its own dashboard password; the env DASHBOARD_PASSWORD
-- becomes the ADMIN (founder) master key that can view/register any business.

alter table businesses add column if not exists dashboard_password text;

-- Slugs must be unique (each business is addressable) — safe if already unique.
create unique index if not exists businesses_slug_uniq on businesses (slug);
-- 0009_self_signup.sql — self-service registration with double opt-in.
-- A signup is written consent (form). It stays 'pending' until the person texts
-- the number from the phone they gave (mobile-originated opt-in) — then the app
-- creates their isolated business and marks the signup 'activated'.

alter table signups add column if not exists language text default 'en';
alter table signups add column if not exists status text not null default 'pending';
alter table signups add column if not exists activated_at timestamptz;
alter table signups add column if not exists business_id uuid references businesses(id) on delete set null;
create index if not exists signups_phone_status_idx on signups (phone, status);
-- 0010_signup_password.sql — let self-registering operators choose a dashboard
-- password at signup. Carried onto their business when they activate by text.
alter table signups add column if not exists dashboard_password text;
-- 0011_security.sql — login throttling.
-- One row per identifier (a phone number, or "admin"); counts recent failures
-- and holds a lockout window. Backups go to Supabase Storage (bucket created at
-- runtime), so no table is needed for those.

create table if not exists auth_throttle (
  id_key       text primary key,       -- E.164 phone, or "admin"
  fails        int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

alter table auth_throttle enable row level security;
