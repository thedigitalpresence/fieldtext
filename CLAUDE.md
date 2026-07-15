Follow the agent guidelines in @AGENTS.md for all work in this repository.

Shipping policy (hybrid, per Eric):
- Small, low-risk fixes (copy, styling, a wrong reply) → commit straight to main (auto-deploys).
- Anything touching money/ledger, the database schema, or the inbound webhook → branch + PR following the template; Eric merges.

Project quick facts:
- Run tests: `npm test` (must cd into this directory; Node via nvm)
- Typecheck: `npx tsc --noEmit`
- Deploys: push to main → Vercel auto-deploys production (fieldtextapp.com)
- Database migrations live in `supabase/migrations/` and are run manually by Eric in the Supabase SQL editor — always call out a new migration in the summary
- No em-dashes in any user-facing copy (SMS templates, UI, emails)
- Never invent the operator's schedule/availability in generated customer-facing text
