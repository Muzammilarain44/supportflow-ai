/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#0B1120', sidebar: '#111827', card: '#171E32',
        primary: '#7C3AED', success: '#22C55E', warning: '#F59E0B', danger: '#EF4444',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
