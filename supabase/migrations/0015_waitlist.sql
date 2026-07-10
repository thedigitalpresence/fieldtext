-- Beta waitlist: public signups that are LEADS, not accounts.
-- The founder reviews these in /dashboard/waitlist and hand-picks who to invite.
-- Nothing here creates an authorized_phone or business — going live is a manual step.
create table if not exists waitlist (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  name          text not null,
  business_name text,
  phone         text not null,          -- E.164
  trade         text,                    -- "what do you do"
  needs         text,                    -- "what do you need it for"
  language      text not null default 'en',
  timezone      text not null default 'America/Los_Angeles',
  consent_text  text,
  consented_at  timestamptz,
  ip            text,
  status        text not null default 'new',   -- new | invited | active | passed
  notes         text                     -- founder's private notes
);

-- One live lead per phone; re-submitting updates the same row.
create unique index if not exists waitlist_phone_key on waitlist (phone);

-- Founder view sorts newest-first.
create index if not exists waitlist_created_idx on waitlist (created_at desc);

-- RLS on, no public policies: only the service-role key (server) can read/write.
alter table waitlist enable row level security;
