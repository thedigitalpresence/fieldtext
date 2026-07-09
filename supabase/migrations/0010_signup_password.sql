-- 0010_signup_password.sql — let self-registering operators choose a dashboard
-- password at signup. Carried onto their business when they activate by text.
alter table signups add column if not exists dashboard_password text;
