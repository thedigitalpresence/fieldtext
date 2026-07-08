# FieldText

A text-driven CRM + reminder assistant for a landscaping business. **The landscaper
is the user.** They text one number in plain language to log and manage their
business; an LLM (Claude) parses each message into structured data, saves it, and
texts a confirmation back. FieldText also sends scheduled reminders and follow-up
nudges, and answers questions the owner texts in.

No app to open, no forms — texting is the whole interface, because the owner is in
the field all day.

```
Owner texts:  quoted angela jones at 333 jones avenue for $500 a month, full coverage
FieldText:    Got it ✅ Logged Angela Jones, 333 Jones Avenue — $500/mo, full coverage,
              status: Quoted. I'll nudge you to follow up in 3 days if it's still open.

Owner texts:  who do I still need to follow up with?
FieldText:    Just Angela Jones ($500/mo, 333 Jones Ave) — quoted, not closed yet.

Owner texts:  angela accepted, starts monday
FieldText:    Updated ✅ Angela Jones → Active.
```

Single business for the MVP, but built multi-tenant-ready: onboard another business
by adding a `businesses` row + its `authorized_phones`, no code change.

---

## Stack

- **Next.js (App Router, TypeScript)** — deploy on Vercel
- **Supabase (Postgres)** with **Row-Level Security** on — data + SQL migrations
- **Twilio Programmable Messaging** — one designated business number, inbound webhook
- **Anthropic Claude** — `parseMessage()` via **tool-calling / structured output**, model swappable by env
- **Cron** — `/api/cron/run-due` for charges, reminders, nudges + digests (daily on Vercel Hobby; add an external 10–15 min pinger per LAUNCH.md)
- **Tailwind** — mobile-friendly owner dashboard

---

## The LLM parsing layer (the heart of the product)

Every inbound text goes to [`parseMessage()`](src/lib/anthropic.ts), which calls Claude
with a **single forced tool** (`record_message`) so every response is schema-valid
structured data: `{ intent, confidence, ...entities }`. Supported intents:

| Intent | Example | What happens |
|---|---|---|
| `log_quote` | "quoted angela at 5 oak for $200/mo, mowing" | Create/update client, status `quoted` |
| `update_status` | "angela accepted", "the smiths cancelled", "mark 5 oak active" | Fuzzy-match client, change status |
| `log_job` | "mowed the smiths today" | Record a job, link to client if known |
| `log_payment` | "collected $500 from angela" | Record a payment |
| `set_reminder` | "remind me to invoice the smiths friday" | Schedule an SMS reminder |
| `query` | "who do I need to follow up with?", "what's my MRR?" | Fetch rows → Claude composes a short answer |
| `help` | unclear / missing info | Text back a short clarifying question instead of guessing |

The module is **swappable** — change `ANTHROPIC_MODEL`, or replace
[`src/lib/anthropic.ts`](src/lib/anthropic.ts), and nothing else changes. Relative
dates ("friday", "in 3 days") are resolved by the model using the current time +
business timezone passed in the prompt. Fuzzy client matching and "which Angela?"
disambiguation live in [`src/lib/clients.ts`](src/lib/clients.ts).

### Model choice & running cost

Default is `claude-opus-4-8` (most capable). For a high-volume SMS parser you'll
likely want a cheaper model — set `ANTHROPIC_MODEL`:

| Model | Input / Output per 1M tokens | Notes |
|---|---|---|
| `claude-haiku-4-5` | **$1 / $5** | Cheapest; great fit for short-message parsing |
| `claude-sonnet-4-6` | $3 / $15 | Middle ground |
| `claude-opus-4-8` | $5 / $25 | Most capable (default) |

A typical parse is a few hundred tokens in + ~100 out, so **well under a tenth of a
cent per message on Haiku**. Each inbound SMS is one parse (queries add a second,
short call). Twilio adds roughly **$0.0079 per SMS segment** sent/received in the US
(plus number rental). Budget for both per message.

---

## ⚠️ Read first: US business texting requires A2P 10DLC registration

Before Twilio reliably delivers your business texts to US mobile numbers you **must**
register **A2P 10DLC** (brand + campaign) in the Twilio Console: create a Brand
(your EIN), a Campaign (use case = customer care / business notifications, with
sample messages), and attach your number via a Messaging Service. This takes **a few
days** and has **small one-time + monthly fees**, and **cannot be skipped** — until
it's approved, carriers heavily filter or silently drop your messages.

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Database (Supabase)
1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run, in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_seed.sql` (edit the business + owner phone first!)
3. Copy the **Project URL** and **service-role key** (Settings → API).

### 3. Environment
```bash
cp .env.example .env.local
```
Fill in every value. `# TODO` markers flag what must be real before going live
(Twilio creds, the A2P-registered number, the Anthropic key, the owner's authorized
phone).

| Variable | What it is |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project + service-role key (server only) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_FROM_NUMBER` | Your **A2P-registered** business number (E.164) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ANTHROPIC_MODEL` | Parser model (default `claude-opus-4-8`; see cost table) |
| `CRON_SECRET` | Protects the cron endpoint (Vercel sends it automatically) |
| `DASHBOARD_PASSWORD` | Password for `/dashboard` |
| `DEFAULT_BUSINESS_SLUG` | Which business the dashboard/cron operate on |

### 4. Wire up Twilio
Phone number → **Messaging** → "A message comes in" → **Webhook**, **HTTP POST**:
`https://<your-domain>/api/sms/inbound`. The owner's cell must be in
`authorized_phones` (only authorized numbers are accepted).

### 5. Run
```bash
npm run dev   # http://localhost:3000
```

---

## Deploy on Vercel
1. Push to GitHub, import into Vercel.
2. Add all env vars (Production + Preview); set `NEXT_PUBLIC_APP_URL` to your domain
   (used for the Twilio signature check).
3. Deploy — `vercel.json` registers the cron (`/api/cron/run-due` every 5 min);
   Vercel sends `Authorization: Bearer $CRON_SECRET`, which the endpoint verifies.
4. Point the Twilio inbound webhook at your production URL.

---

## Security

- **Authorized numbers only** — inbound texts from a number not in `authorized_phones`
  are silently ignored ([`src/lib/inbound.ts`](src/lib/inbound.ts)).
- **RLS on every table** — all access is server-side via the service-role key; with no
  RLS policies, the public/anon key can never read a business's data, and a business
  can only ever see its own rows.
- **Twilio signature verification** on the inbound webhook (toggle for local testing).
- **Secrets in env only.** Message bodies go only to the LLM needed to parse them.
- Dashboard is behind a password (MVP-grade single password; upgrade before
  multi-tenant).

---

## Test locally (no Supabase / Twilio / Anthropic needed)

`.env.local` ships in test mode: file-backed mock DB, SMS dry-run (texts logged to
console), and a built-in heuristic parser (no API key). Run the whole loop:

```bash
npm run dev
bash scripts/local-smoke.sh          # texts the example messages, prints replies
rm .fieldtext-test-db.json           # reset to a clean slate
```

When you add a real `ANTHROPIC_API_KEY` (and unset `LLM_DRY_RUN`/`LOCAL_TEST`), the
same flow uses Claude for parsing. Acceptance checks the smoke test covers:

- "quoted angela jones at 333 jones avenue for $500 a month, full coverage" → correct client+quote + accurate confirmation.
- "angela accepted" → status → active.
- "remind me to follow up with angela in 3 days" → reminder scheduled (fires via cron at the right time).
- "who do I still need to follow up with?" → short answer from the data.
- A quote left untouched past the configured window → automatic follow-up nudge (cron).
- Texts from unauthorized numbers are ignored.

---

## Data model
`businesses` · `authorized_phones` · `clients` (status: quoted→active→completed→lost) ·
`jobs` · `payments` · `reminders` (pending→sent) · `messages` (full inbound/outbound +
parsed-intent audit log). See `supabase/migrations/0001_init.sql`.

## Notes (intentionally simple MVP)
- No payments processing, customer portal, or calendar — just the texting loop, done well.
- Owner dashboard uses one shared password — fine for one owner; upgrade for multi-tenant.
- The heuristic offline parser is for local testing only; production uses Claude.
