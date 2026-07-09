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
