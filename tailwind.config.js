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
          950: '#05070a',
          900: '#0b0f15',
          850: '#0f141b',
          800: 'rgba(255,255,255,0.06)',
          700: 'rgba(255,255,255,0.09)',
          600: 'rgba(238,241,245,0.35)',
          500: 'rgba(238,241,245,0.45)',
        },
        mist: {
          100: '#eef1f5',
          300: 'rgba(238,241,245,0.65)',
        },
        signal: {
          300: '#ff9478',
          400: '#ff7a54',
          500: '#ef5b34',
          600: '#d84a26',
        },
        ok: {
          300: '#8fe8c3',
          500: '#35d399',
        },
        amber: {
          500: '#f0b429',
        },
        danger: {
          500: '#ff6b5e',
        },
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
