/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'ds-bg': '#0f1117',
        'ds-surface': '#1a1d27',
        'ds-border': '#2a2d3a',
        'ds-accent': '#6366f1',
        'ds-green': '#22c55e',
      },
    },
  },
  plugins: [],
};
