-- Small key/value store for app-wide state. First use: the cron heartbeat, so a
-- dead reminder pinger can't silently stop reminders (we text the founder).
create table if not exists system_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS on, no public policies: only the service-role key (server) touches it.
alter table system_state enable row level security;
