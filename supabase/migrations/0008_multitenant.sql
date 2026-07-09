-- 0008_multitenant.sql — per-business dashboard login.
-- Each business gets its own dashboard password; the env DASHBOARD_PASSWORD
-- becomes the ADMIN (founder) master key that can view/register any business.

alter table businesses add column if not exists dashboard_password text;

-- Slugs must be unique (each business is addressable) — safe if already unique.
create unique index if not exists businesses_slug_uniq on businesses (slug);
