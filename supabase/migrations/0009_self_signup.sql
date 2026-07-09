-- 0009_self_signup.sql — self-service registration with double opt-in.
-- A signup is written consent (form). It stays 'pending' until the person texts
-- the number from the phone they gave (mobile-originated opt-in) — then the app
-- creates their isolated business and marks the signup 'activated'.

alter table signups add column if not exists language text default 'en';
alter table signups add column if not exists status text not null default 'pending';
alter table signups add column if not exists activated_at timestamptz;
alter table signups add column if not exists business_id uuid references businesses(id) on delete set null;
create index if not exists signups_phone_status_idx on signups (phone, status);
