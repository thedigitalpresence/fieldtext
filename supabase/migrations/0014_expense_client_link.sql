-- Link expenses to a client so "spent 100 on mulch for Elena" shows on Elena's
-- card (job-costing per client). Nullable: most expenses are general overhead.
alter table expenses add column if not exists client_id uuid references clients(id) on delete set null;
create index if not exists expenses_client_idx on expenses (client_id);
