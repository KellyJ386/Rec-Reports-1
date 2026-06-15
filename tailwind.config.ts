import type { Config } from "tailwindcss";

/**
 * Brand tokens are defined here once (CLAUDE.md §4). Never hardcode hex in components —
 * reference `forest`, `amber`, `navy`. Status/severity must pair color with a text/icon
 * label (CLAUDE.md §4) — color is never the only signal.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./modules/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        forest: {
          DEFAULT: "#1B4332",
          50: "#E8F0EC",
          100: "#C5DACE",
          600: "#1B4332",
          700: "#153728",
          800: "#0F2A1E",
        },
        amber: {
          DEFAULT: "#D97706",
          50: "#FDF3E7",
          100: "#FAE0BF",
          600: "#D97706",
          700: "#B45F05",
        },
        navy: {
          DEFAULT: "#1E3A5F",
          600: "#1E3A5F",
          700: "#172C48",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
