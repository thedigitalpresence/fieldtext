-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the single MVP business + the owner's authorized phone.
-- EDIT these values for your real business before going live.
-- ─────────────────────────────────────────────────────────────────────────────

insert into businesses (slug, name, owner_name, timezone, settings)
values (
  'green-acres',                       -- TODO: matches DEFAULT_BUSINESS_SLUG
  'Green Acres Landscaping',           -- TODO: real business name
  'Mike',                              -- TODO: real owner first name
  'America/Los_Angeles',               -- TODO: set your timezone (530 area code → Pacific)
  jsonb_build_object(
    'followup_days', 3,                -- (legacy) nudge window
    'digest_enabled', false,           -- optional morning digest
    'digest_hour', 7,                  -- local hour (0-23) to send the digest
    'billing_enabled', false,          -- usage/cost logging off by default (set true to enable)
    'quote_reminder_days', jsonb_build_array(2, 5, 7, 14),  -- auto quote follow-up cadence
    'language', 'en'                   -- operator language for UI + outbound texts (en | es)
  )
)
on conflict (slug) do nothing;

-- The owner's REAL cell. Only authorized numbers may text the system, and the
-- primary one receives reminders, nudges, and the optional digest.
insert into authorized_phones (business_id, phone, label, is_primary)
select id, '+15306056728', 'Owner cell', true    -- your cell (authorized + reminder recipient)
from businesses where slug = 'green-acres'
on conflict (phone) do nothing;
