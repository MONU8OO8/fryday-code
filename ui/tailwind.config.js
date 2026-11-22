/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // One palette for every screen, light or dark (see src/index.css).
        hud: {
          bg:      'rgb(var(--hud-bg) / <alpha-value>)',
          surface: 'rgb(var(--hud-surface) / <alpha-value>)',
          border:  'rgb(var(--hud-border) / <alpha-value>)',
          cyan:    'rgb(var(--hud-cyan) / <alpha-value>)',   // the accent (indigo in the new look)
          amber:   'rgb(var(--hud-amber) / <alpha-value>)',
          green:   'rgb(var(--hud-green) / <alpha-value>)',
          red:     'rgb(var(--hud-red) / <alpha-value>)',
          dim:     'rgb(var(--hud-dim) / <alpha-value>)',
          bright:  'rgb(var(--hud-bright) / <alpha-value>)',
          onaccent: 'rgb(var(--hud-onaccent) / <alpha-value>)', // text on cyan or green buttons
        },
      },
      // No font is downloaded: Inter when installed, else the system font. Mono is for code only.
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        // The Studio card: barely there.
        card: '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.05)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
      },
    },
  },
  plugins: [],
};
