/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // El side panel de Chrome ronda los 320-400 px. Todo se diseña a una
      // columna; este ancho es el suelo con el que se comprueba el layout.
      minWidth: { panel: '320px' },
      colors: {
        ink: {
          900: '#0b0d12',
          800: '#11141b',
          700: '#181c26',
          600: '#222734',
          500: '#2e3543',
        },
        mint: {
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
        },
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'upgrade-in': {
          '0%': { opacity: '0', transform: 'translateY(6px) scale(0.985)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
        // Beat 2: la transición del esqueleto al resultado de la IA.
        'upgrade-in': 'upgrade-in 380ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 200ms ease-out both',
      },
    },
  },
  plugins: [],
};
