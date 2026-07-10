/**
 * FieldText mark: a message bubble (nods to "Text") with the F knocked out and a
 * chat tail. Trade-neutral — no leaf. The bubble is `currentColor` (set it with
 * a text-brand class); the F is white. Self-contained, so it replaces the whole
 * green-square + icon wrapper.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label="FieldText">
      <rect x="3" y="4" width="34" height="26" rx="8" fill="currentColor" />
      <path d="M12 30 L12 37 L20 30 Z" fill="currentColor" />
      <path d="M15 11 H27 V15 H19.5 V18.5 H26 V22.5 H19.5 V27 H15 Z" fill="#fff" />
    </svg>
  );
}
