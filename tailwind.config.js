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
        // ====================================================================
        // Palette du template « Stark Meet » (système de design Genesis)
        // ====================================================================
        // Thème clair. Le primaire est le bleu #1A6DFF : les trois pages du
        // template surchargent l'indigo #6366F1 du système de design dans leur
        // propre <style>, c'est donc ce bleu qui fait foi.
        brand: {
          50: '#EEF3FF',  // teinte de fond (puces, bandeaux d'information)
          500: '#1A6DFF', // primaire
          600: '#0B57D0', // primaire au survol
        },
        // Échelle de gris : texte, bordures et fonds d'interface.
        slate: {
          950: '#0A0A0A', // texte principal (jamais du noir pur)
          700: '#6B6B6B', // texte secondaire
          500: '#9C9C9C', // texte atténué, indications, désactivé
          200: '#E8E8EC', // bordures
          100: '#F1F1F4', // puces, remplissage au survol
          50: '#FAFAFA',  // fond de page
        },
        surface: '#FFFFFF', // cartes, panneaux, barres
        canvas: '#F1F2F6',  // fond de la page réunion (plus soutenu)
        // Les tuiles vidéo restent sombres, comme dans le template : c'est du
        // contenu vidéo, pas une surface d'interface.
        stage: '#0A0A0A',
        success: { 50: '#E7F8F1', 500: '#10B981' },
        warning: { 50: '#FEF4E3', 500: '#F59E0B' },
        error: { 50: '#FDECEC', 500: '#EF4444' },

        // ====================================================================
        // Ancienne palette sombre — à retirer en fin de portage
        // ====================================================================
        // Conservée le temps que tous les écrans passent au nouvel habillage :
        // la supprimer maintenant viderait les classes des composants encore
        // non repris et les rendrait illisibles entre deux étapes.
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
        // display : General Sans, réservé aux titres (gros, tracking serré)
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
      },
      // Échelle typographique du système de design (tokens/typography.css)
      letterSpacing: {
        display: '-0.04em',
        heading: '-0.03em',
        overline: '0.08em',
      },
      borderRadius: {
        // 4 puces · 6 boutons/champs · 8 panneaux · 12 cartes (tokens/radius.css)
        xs: '4px',
        sm: '6px',
        md: '8px',
        lg: '12px',
      },
      boxShadow: {
        'card-hover': '0 8px 30px rgba(0,0,0,0.08)',
        'brand-glow': '0 4px 12px rgba(26,109,255,0.35)',
        lg: '0 12px 32px rgba(10,10,10,0.12)',
        overlay: '0 24px 60px rgba(10,10,10,0.18)',
        focus: '0 0 0 3px rgba(26,109,255,0.12)',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0.6, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
