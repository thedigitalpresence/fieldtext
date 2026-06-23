#!/usr/bin/env bash
# Drives the full FieldText loop against a locally-running dev server (npm run dev).
# Requires LOCAL_TEST=true + SMS_DRY_RUN=true + LLM_DRY_RUN=true (see .env.local).
# No real SMS/LLM calls are made.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
CRON_SECRET="${CRON_SECRET:-test-cron-secret}"
OWNER="${OWNER:-+15555550100}"   # the authorized owner phone (seeded)

# Send a text "from" the owner to the inbound webhook and print the reply.
send() {
  local body="$1"
  echo "📱 owner: $body"
  local reply
  reply=$(curl -s -X POST "$BASE/api/sms/inbound" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "From=$OWNER" --data-urlencode "To=+15555550111" \
    --data-urlencode "Body=$body" --data-urlencode "MessageSid=SM$RANDOM" \
    | sed -E 's:.*<Message>(.*)</Message>.*:\1:; s:<[^>]+>::g')
  echo "🤖 FieldText: ${reply:-（no reply / ignored）}"
  echo
}

echo "═══ Core loop (the Angela Jones example) ═══"; echo
send "quoted angela jones at 333 jones avenue for \$500 a month, full coverage"
send "remind me to follow up with angela in 3 days"
send "who do I still need to follow up with?"
send "angela accepted, starts monday"
send "mowed the smiths today"
send "collected \$500 from angela"
send "what's my monthly recurring revenue?"

echo "═══ Security: text from an UNAUTHORIZED number (should be ignored) ═══"; echo
echo "📱 stranger (+19998887777): hello"
curl -s -o /dev/null -w "   HTTP %{http_code}, empty reply = ignored\n" -X POST "$BASE/api/sms/inbound" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "From=+19998887777" --data-urlencode "To=+15555550111" \
  --data-urlencode "Body=hello"
echo

echo "═══ Reminders cron (nothing due yet — reminder is 3 days out) ═══"
curl -s -X POST "$BASE/api/cron/run-due" -H "x-cron-secret: $CRON_SECRET" | sed 's/^/   /'
echo; echo
echo "✅ Done. Open $BASE/dashboard (password: test) to see the pipeline + data."
