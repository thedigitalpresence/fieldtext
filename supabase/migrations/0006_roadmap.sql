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
