-- ─────────────────────────────────────────────────────────────────────────────
-- 0004 — production hardening: idempotent webhooks + STOP/opt-out compliance
-- ─────────────────────────────────────────────────────────────────────────────

-- Store Twilio's MessageSid so a retried webhook can't double-process a text.
alter table messages add column if not exists external_id text;
create index if not exists messages_external_idx on messages (business_id, external_id);

-- A2P compliance: honor STOP even on an owner-facing line. When set, we never
-- text this number (reminders, nudges, confirmations) until they reply START.
alter table authorized_phones add column if not exists opted_out boolean not null default false;
