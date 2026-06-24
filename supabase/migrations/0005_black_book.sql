-- ─────────────────────────────────────────────────────────────────────────────
-- 0005 — black book: recurring service schedule + payment status
-- Extends existing tables (non-breaking; all columns nullable / defaulted).
-- ─────────────────────────────────────────────────────────────────────────────

-- Recurring service schedule for ACTIVE clients (distinct from billing_period).
--   service_interval: weekly | biweekly | monthly | null (one-off)
--   service_day:      preferred day, lowercase english ('tuesday')
--   next_service_on:  the next visit date (computed from interval + day)
alter table clients add column if not exists service_interval text;
alter table clients add column if not exists service_day text;
alter table clients add column if not exists next_service_on date;
create index if not exists clients_next_service_idx on clients (business_id, next_service_on);

-- Payment status so the book tracks what's owed, not just what's collected.
--   paid | unpaid | overdue
alter table payments add column if not exists status text not null default 'paid';
create index if not exists payments_status_idx on payments (business_id, status);
