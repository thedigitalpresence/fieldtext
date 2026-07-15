-- Client credit: unapplied payment money (paid early, or overpaid) is banked
-- here instead of vanishing, and is consumed automatically by the next charge.
alter table clients add column if not exists credit numeric not null default 0;
