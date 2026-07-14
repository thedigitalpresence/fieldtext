"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Light/dark toggle. The choice persists in localStorage ("ft-theme"); with no
 * saved choice, the pre-paint script in layout.tsx follows the system setting.
 */
export default function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState<boolean | null>(null); // null until mounted
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const flip = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("ft-theme", next ? "dark" : "light"); } catch { /* private mode */ }
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={flip}
      title={dark ? "Light mode" : "Dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={className ?? "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-2.5 text-gray-600 hover:bg-gray-100"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
