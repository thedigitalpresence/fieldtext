-- 0012_password_reset.sql — SMS password reset.
-- One active reset per phone. The 6-digit code is stored hashed; texting it to
-- the number that owns the account proves control (the number is the username).

create table if not exists password_resets (
  phone       text primary key,
  business_id uuid references businesses(id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table password_resets enable row level security;
