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
  "Bob paid 300",
  "remind me to call Jane friday",
  "rained out, push today to tomorrow",
  "who owes me?",
];

function fakeReply(input: string): string {
  const t = input.toLowerCase();
  if (/quote|quoted|cotic/.test(t)) {
    const name = input.match(/quoted\s+([a-z]+(?:\s[a-z]+)?)/i)?.[1] ?? "Jane";
    const amt = input.match(/\$?\s?(\d[\d,]*)/)?.[1] ?? "200";
    const cap = name.replace(/\b\w/g, (c) => c.toUpperCase());
    return `Got it ✅ ${cap} · $${amt}/mo · Quoted. I'll nudge you if they go quiet — reply "no" to fix.`;
  }
  if (/owes me|who owes|debe/.test(t)) return "Bob Smith owes $450 (oldest due Jun 24). Everyone else is settled ✅";
  if (/paid|collected|venmo|pag/.test(t)) {
    const amt = input.match(/\$?\s?(\d[\d,]*)/)?.[1] ?? "300";
    return `Recorded ✅ $${amt} from Bob on Jul 7. Bob is all settled ✅`;
  }
  if (/remind/.test(t)) return `Reminder set ✅ I'll text you Fri, Jul 10, 9:00 AM: call Jane`;
  if (/rain|push/.test(t)) return "Moved ✅ 3 stop(s) → Jul 8: The Smiths, Garcia, Jane.";
  if (/invoice/.test(t)) return "Invoice for Bob ($450): fieldtextapp.com/i/a1b2…\nForward it from your phone 👍";
  if (/mowed|mow|cut|trim|clean/.test(t)) return "Logged ✅ mowing for The Smiths on Jul 7. Next visit Jul 14.";
  return 'I can log quotes, jobs, payments, and reminders — try "quoted Jane at 5 Oak St for $200/mo".';
}

export default function DemoWidget() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "ft", text: "This is a live demo — text me like you'd text FieldText. Try a suggestion below 👇" },
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
        Try it — simulated demo
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
