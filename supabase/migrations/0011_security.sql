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
