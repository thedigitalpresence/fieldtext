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
