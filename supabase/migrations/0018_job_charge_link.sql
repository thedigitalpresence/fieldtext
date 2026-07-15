-- Link job charges to the job that created them, so deleting a job can remove
-- the money it put on the books (fixes phantom "who owes me" debt).
alter table charges add column if not exists job_id uuid references jobs(id) on delete set null;
