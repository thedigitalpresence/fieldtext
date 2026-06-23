import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FieldText",
  description: "Run your landscaping business by text message.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
