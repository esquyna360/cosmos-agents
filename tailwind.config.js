/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "var(--void)",
        panel: "var(--panel)",
        raised: "var(--raised)",
        float: "var(--float)",
        sunken: "var(--sunken)",
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        ink: "var(--text)",
        dim: "var(--text-dim)",
        faint: "var(--text-faint)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        "accent-ink": "var(--accent-ink)",
        live: "var(--live)",
        busy: "var(--busy)",
        alert: "var(--alert)",
        // Overlay scale. Components say `bg-fill-2` and stay correct in both
        // light and dark themes, where the underlying rgba flips polarity.
        fill: {
          DEFAULT: "var(--fill-1)",
          1: "var(--fill-1)",
          2: "var(--fill-2)",
          3: "var(--fill-3)",
          4: "var(--fill-4)",
        },
      },
      fontFamily: {
        mono: ['"Fira Code"', "ui-monospace", "monospace"],
      },
      borderRadius: {
        cx: "var(--radius)",
        "cx-lg": "var(--radius-lg)",
      },
      boxShadow: {
        cx: "var(--shadow-1)",
        "cx-lg": "var(--shadow-2)",
      },
    },
  },
  plugins: [],
};
