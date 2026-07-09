-- 0013_beta_hardening.sql — pre-beta security fixes.
-- Activation code: self-signups must text this code (shown only on the signup
-- success screen) to activate — proves form-filler AND phone-owner are the same
-- person, killing signup-squatting.
alter table signups add column if not exists activation_code text;
-- Timezone chosen at signup (was hardcoded Pacific — East Coast testers got
-- day sheets and reminders on the wrong clock).
alter table signups add column if not exists timezone text;
