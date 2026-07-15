Follow the agent guidelines in @AGENTS.md for all work in this repository.

Project quick facts:
- Run tests: `npm test` (must cd into this directory; Node via nvm)
- Typecheck: `npx tsc --noEmit`
- Deploys: push to main → Vercel auto-deploys production (fieldtextapp.com)
- Database migrations live in `supabase/migrations/` and are run manually by Eric in the Supabase SQL editor — always call out a new migration in the summary
- No em-dashes in any user-facing copy (SMS templates, UI, emails)
- Never invent the operator's schedule/availability in generated customer-facing text
