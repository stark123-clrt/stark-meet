/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './app/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0e1116',
          900: '#161b23',
          850: '#1a202a',
          800: '#1f2530',
          700: '#2a3140',
          600: '#3a4354',
          500: '#545f73',
        },
        mist: {
          100: '#eef0f4',
          300: '#b7bfcc',
        },
        signal: {
          300: '#ff8b69',
          400: '#ff7452',
          500: '#ff5a36',
        },
        ok: {
          300: '#7fe8b3',
          500: '#3ddc8a',
        },
        amber: {
          500: '#f5b23d',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SF Mono', 'Cascadia Code', 'Segoe UI Mono', 'Consolas', 'monospace'],
        sans: ['ui-sans-serif', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
