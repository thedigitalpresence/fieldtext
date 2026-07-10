-- Collect an email on the beta waitlist so the founder can send invite emails.
alter table waitlist add column if not exists email text;
