import type { MetadataRoute } from "next";

// Add-to-home-screen is THE distribution channel for a truck-cab app:
// standalone display, dashboard start URL, brand splash colors.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FieldText",
    short_name: "FieldText",
    description: "Run your landscaping business by text — quotes, jobs, payments, reminders.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#F4F6F2",
    theme_color: "#15803d",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
