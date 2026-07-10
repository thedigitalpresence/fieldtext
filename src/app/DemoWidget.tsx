"use client";

/**
 * Try-it demo widget: a simulated FieldText conversation using the REAL reply
 * copy. Pure front-end — works before A2P approval, costs nothing per use.
 */
import { useRef, useState } from "react";
import { Send } from "lucide-react";

type Msg = { from: "you" | "ft"; text: string };

const SUGGESTIONS = [
  "quoted Jane at 5 Oak St for $200/mo mowing",
  "they're in",
  "spent 100 on mulch for Elena",
  "Bob paid 300",
  "who owes me?",
  "what's Monday look like?",
];

function fakeReply(input: string): string {
  const t = input.toLowerCase();
  // Quote close-loop replies (the marquee feature) — check before generic "quote".
  if (/\b(they'?re in|accepted|signed|won|closed the deal)\b/.test(t)) return "🎉 Jane's in! Moved them to active.";
  if (/\b(they'?re out|passed|declined|went with|no reply|not yet|no word)\b/.test(t)) return "👍 Staying on Jane — I'll check back with you in 6h.";
  if (/quote|quoted|cotic/.test(t)) {
    const name = input.match(/quoted\s+([a-z]+(?:\s[a-z]+)?)/i)?.[1] ?? "Jane";
    const amt = input.match(/\$?\s?(\d[\d,]*)/)?.[1] ?? "200";
    const cap = name.replace(/\b\w/g, (c) => c.toUpperCase());
    return `Got it ✅ ${cap} · $${amt}/mo · mowing · Quoted. I'll chase the follow-up until it's won or out.`;
  }
  if (/owes me|who owes|debe/.test(t)) return "Bob owes $450 · Elena owes $120. Everyone else is settled ✅";
  if (/spent|bought|gas|fuel|mulch|materials/.test(t)) {
    const amt = input.match(/\$?\s?(\d[\d,]*)/)?.[1] ?? "100";
    const forM = input.match(/for\s+([a-z]+)/i);
    return forM
      ? `Expense ✅ $${amt} — mulch · saved to ${forM[1].replace(/\b\w/, (c) => c.toUpperCase())}'s card.`
      : `Expense ✅ $${amt} — materials.`;
  }
  if (/paid|collected|venmo|pag/.test(t)) {
    const amt = input.match(/\$?\s?(\d[\d,]*)/)?.[1] ?? "300";
    return `Payment ✅ $${amt} from Bob — Bob's all settled ✅`;
  }
  if (/remind/.test(t)) return "Reminder set ✅ I'll text you Fri 9:00 AM: call Jane";
  if (/monday|tuesday|wednesday|thursday|friday|route|look like|schedule/.test(t)) {
    return "☀️ Mon, mostly sunny 72°/54°\n• The Smiths — 12 Oak St\n• Garcia — 8 Elm St\n• Jane — 5 Oak St";
  }
  if (/rain|push/.test(t)) return "Moved ✅ 3 stops → tomorrow: The Smiths, Garcia, Jane.";
  if (/invoice/.test(t)) return "Invoice for Bob ($450): fieldtextapp.com/i/a1b2…\nForward it from your phone 👍";
  if (/mowed|mow|cut|trim|clean/.test(t)) return "Logged ✅ mowing for The Smiths. Next visit in 7 days.";
  return 'Text me like you talk — try "quoted Jane at 5 Oak St for $200/mo" or "who owes me?".';
}

export default function DemoWidget() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "ft", text: "This is a live demo. Text me like you'd text FieldText. Try a suggestion below 👇" },
  ]);
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  function send(text: string) {
    const clean = text.trim();
    if (!clean) return;
    setMsgs((m) => [...m, { from: "you", text: clean }]);
    setInput("");
    setTimeout(() => {
      setMsgs((m) => [...m, { from: "ft", text: fakeReply(clean) }]);
      setTimeout(() => scroller.current?.scrollTo({ top: 99999, behavior: "smooth" }), 50);
    }, 450);
    setTimeout(() => scroller.current?.scrollTo({ top: 99999, behavior: "smooth" }), 50);
  }

  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white text-left shadow-sm">
      <div className="border-b border-gray-100 bg-brand/5 px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-brand-dark">
        Try it: simulated demo
      </div>
      <div ref={scroller} className="h-64 space-y-2 overflow-y-auto p-3">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.from === "you" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.from === "you" ? "rounded-br-sm bg-brand text-white" : "rounded-bl-sm bg-gray-100 text-gray-800"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-gray-100 px-3 pt-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => send(s)}
            className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600 hover:bg-brand/10 hover:text-brand-dark"
          >
            {s}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="flex items-center gap-2 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Text like you talk…"
          aria-label="Demo message"
          className="min-h-[44px] flex-1 rounded-xl border border-gray-200 px-3 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <button aria-label="Send" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-brand text-white hover:bg-brand-dark">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
