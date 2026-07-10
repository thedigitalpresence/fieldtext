/**
 * FieldText mark: a message bubble (nods to "Text") holding an "FT" ligature —
 * the F and T share one top bar, so the top of the F meets the top of the T.
 * Trade-neutral, no leaf. The bubble is `currentColor` (set it with a text-brand
 * class); the letters are white. Padded viewBox so it breathes top and bottom.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label="FieldText">
      {/* speech bubble + tail */}
      <rect x="6" y="6" width="36" height="28" rx="8" fill="currentColor" />
      <path d="M14 34 L14 41 L22 34 Z" fill="currentColor" />
      {/* FT ligature — shared top bar joins the two letters */}
      <rect x="12" y="12" width="25" height="3.4" rx="1.2" fill="#fff" />
      <rect x="12" y="12" width="3.4" height="16" rx="1.2" fill="#fff" />
      <rect x="12" y="18.7" width="11" height="3.2" rx="1.2" fill="#fff" />
      <rect x="28" y="12" width="3.4" height="16" rx="1.2" fill="#fff" />
    </svg>
  );
}
