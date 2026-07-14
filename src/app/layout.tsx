import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FieldText", template: "%s — FieldText" },
  description: "Run your business by text message.",
};

export const viewport: Viewport = {
  themeColor: "#15803d",
};

// Applies the saved (or system) theme BEFORE first paint, so dark mode never flashes white.
const THEME_SCRIPT = `try{var q=new URLSearchParams(location.search).get("theme");var t=q||localStorage.getItem("ft-theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
