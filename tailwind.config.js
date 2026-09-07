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
        line: "var(--line)",
        ink: "var(--text)",
        dim: "var(--text-dim)",
        faint: "var(--text-faint)",
        accent: "var(--accent)",
        live: "var(--live)",
        busy: "var(--busy)",
        alert: "var(--alert)",
      },
      fontFamily: {
        mono: ['"Fira Code"', "ui-monospace", "monospace"],
      },
      borderRadius: {
        cx: "var(--radius)",
      },
    },
  },
  plugins: [],
};
