/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'dotted-grid': 'radial-gradient(circle, #e4e4e7 1px, transparent 1px)',
        'dotted-grid-dark': 'radial-gradient(circle, #27272a 1px, transparent 1px)',
      },
    },
  },
  plugins: [],
}
