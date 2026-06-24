import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#15803d", dark: "#166534" }, // refined landscaping green
        canvas: "#F4F6F2", // cool sage page background
      },
    },
  },
  plugins: [],
};

export default config;
