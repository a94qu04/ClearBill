/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'Noto Sans TC',
          'PingFang TC',
          'Microsoft JhengHei',
          'system-ui',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}
