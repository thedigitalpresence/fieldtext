import type { LucideIcon } from "lucide-react";

/**
 * A lucide icon inside the logo's message bubble, so accent icons (the follow-up
 * loop, the demo Send button) match the mark. The bubble body fills the badge;
 * the icon is absolutely centered on the body's center (44 viewBox, body center
 * ≈ 39% down), so it lands dead-center above the tail. Bubble is `text-brand`.
 */
export function IconBubble({ Icon, className, iconClassName }: { Icon: LucideIcon; className?: string; iconClassName?: string }) {
  return (
    <span className={`relative inline-block text-brand ${className ?? ""}`}>
      <svg viewBox="0 0 44 44" className="h-full w-full" aria-hidden="true">
        <rect x="3" y="3" width="38" height="30" rx="9" fill="currentColor" />
        <path d="M12 33 L12 41 L21 33 Z" fill="currentColor" />
      </svg>
      <Icon className={`absolute left-1/2 top-[39%] h-[46%] w-[46%] -translate-x-1/2 -translate-y-1/2 text-white ${iconClassName ?? ""}`} />
    </span>
  );
}

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
