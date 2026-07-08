# FieldText — MVP Launch Runbook

Goes from this repo to a live service one real landscaper can use. Plan for **~1 day
of setup + a few days waiting on A2P 10DLC** (start that first — it's the long pole).

> Architecture note that drives the cost model: FieldText only ever texts **the
> operator** (the landscaper). It never texts their customers. So **one shared
> business number + one A2P registration serves all clients** — inbound is routed
> by the sender's phone (`authorized_phones`). You do *not* provision a number or a
> brand per client.

---

## 0. Start A2P 10DLC today (blocks go-live, takes days)
US carriers filter business texts until you register. In Twilio Console → **Messaging
→ Regulatory Compliance → A2P 10DLC**:
1. Register a **Brand** for your company (FieldText). Needs your business/EIN info
   (sole-prop path exists if you're not incorporated yet).
2. Create a **Campaign** — use case **"Account Notifications" / "Customer Care"**,
   describe it as *"appointment/quote reminders and CRM notifications sent to our own
   subscribed users (landscaping operators)."* Provide sample messages (copy a few
   from `src/lib/templates.ts`) and your opt-in description (users sign up + consent).
3. Attach your number(s) to a **Messaging Service** tied to that campaign.

One-time brand ~\$4, campaign ~\$2–10/mo. Approval is usually a few days. Everything
below can be done while it's pending.

---

## 1. Database — Supabase (free tier is fine)
1. Create a project at [supabase.com](https://supabase.com).
2. SQL editor → run the migrations **in order**:
   `0001_init.sql`, `0002_seed.sql`, `0003_billing_and_quote_reminders.sql`,
   `0004_production_hardening.sql`, `0005_black_book.sql`, `0006_roadmap.sql`.
   (Or run `setup_all.sql`, which now includes all six.)
3. **Edit the seed** (`0002`, or update the row after): set the real business name,
   timezone, and language; set `authorized_phones.phone` to the **landscaper's real
   cell** in E.164 (e.g. `+14155551234`), `is_primary = true`.
4. Settings → API → copy **Project URL** and **service-role key**.

## 2. LLM — Anthropic
1. Get a key at [console.anthropic.com](https://console.anthropic.com).
2. Use `ANTHROPIC_MODEL=claude-haiku-4-5` — cheapest, and plenty for SMS parsing
   (well under a cent per message).

## 3. SMS — Twilio
1. Buy a **local 10DLC number**.
2. Complete A2P (step 0) and attach the number to your Messaging Service.
3. Copy **Account SID** + **Auth Token**; note the number as `TWILIO_FROM_NUMBER`.

## 4. Deploy — Vercel
1. Push this repo to GitHub, import into [Vercel](https://vercel.com). Use **Pro
   ($20/mo)** for reliable cron.
2. Add **all** env vars (Production). Use real values and **omit the test flags**:

   | Var | Value |
   |---|---|
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from Supabase |
   | `ANTHROPIC_API_KEY` | from Anthropic |
   | `ANTHROPIC_MODEL` | `claude-haiku-4-5` |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | from Twilio |
   | `CRON_SECRET` | a long random string |
   | `DASHBOARD_PASSWORD` | the dashboard password |
   | `DEFAULT_BUSINESS_SLUG` | matches your seeded `businesses.slug` |
   | `NEXT_PUBLIC_APP_URL` | your real domain, e.g. `https://fieldtext.vercel.app` (used for Twilio signature check) |

   Optional: `FOUNDER_ALERT_PHONE` — your cell in E.164; new signups text you there.

   **Do NOT set** `LOCAL_TEST`, `SMS_DRY_RUN`, `LLM_DRY_RUN`, or
   `TWILIO_VALIDATE_SIGNATURE` — leaving them off switches the app to the real
   Supabase / Twilio / Claude with signature validation ON. (The signature bypass
   is ignored in production builds regardless — audit hardening.)
3. Deploy. **Cron reality check:** `vercel.json` registers a once-daily cron
   (`0 16 * * *`) because the Hobby plan allows no more — reminders due later in
   the day would slip. Fix ONE of:
   - **Free:** a [cron-job.org](https://cron-job.org) job hitting
     `POST https://<domain>/api/cron/run-due` with header
     `x-cron-secret: <your CRON_SECRET>` every 10–15 minutes, or
   - **Paid:** Vercel Pro + change the schedule to `*/10 * * * *`.
   Vercel's own cron sends `Authorization: Bearer $CRON_SECRET`; the endpoint
   accepts either header.

## 5. Connect Twilio → the app
Twilio Console → your number → **Messaging → "A message comes in"** → **Webhook**,
**HTTP POST**: `https://<your-domain>/api/sms/inbound`.

## 6. Go-live smoke test (from the landscaper's real phone)
- `https://<your-domain>/api/health` → `{"ok":true,"db":true}`.
- Text a quote: `quoted jane at 5 oak st for $200/mo mowing` → personalized confirmation
  with the cleaned data; appears in `/dashboard`.
- Text `who do I need to follow up with?` → short answer.
- Text `español` → confirmation in Spanish + dashboard flips to Spanish.
- Text `STOP` then `START` → opt-out confirm, then resume.
- Manually fire cron once: `curl -X POST https://<domain>/api/cron/run-due -H "x-cron-secret: $CRON_SECRET"`.

## 7. Monitor (first 2 weeks)
- **Vercel → Logs**: watch `/api/sms/inbound` for parse/DB errors.
- Point an uptime monitor (UptimeRobot etc.) at `/api/health`.
- Read the first ~20 real inbound texts in the `messages` table; if any parsed wrong,
  tune the prompt in `src/lib/anthropic.ts` (`systemPrompt`) — no redeploy of logic
  needed, just copy.
- To watch real cost per client, flip `settings.billing_enabled = true` on the
  business row; the `billing_events` table then logs every SMS + LLM call.

---

## Production hardening already in place
- **Idempotent webhook** — Twilio retries are deduped by `MessageSid` (no double-logging).
- **STOP / START** opt-out handling (EN + ES), with proactive sends skipped while opted out.
- **Health check** at `/api/health`.
- **Twilio signature verification** on the inbound webhook (`TWILIO_VALIDATE_SIGNATURE`,
  on by default — needs `NEXT_PUBLIC_APP_URL` set to the real domain).
- Authorized-phone gate, RLS on every table, secrets in env only.

## Onboarding a second landscaper (when the pilot works)
No new number, no new A2P. Insert a `businesses` row + an `authorized_phones` row with
their cell. They text the same shared number; routing is by sender. (Real auth and a
self-serve signup come later — this is the single-tenant-per-row MVP.)

## Rough monthly cost
Fixed platform ~\$40–50 (Vercel Pro, Supabase, A2P, one number). Marginal per client
~\$7–13 (almost all SMS volume; Claude < \$1). Breakeven ~2–3 clients at \$50 each.
