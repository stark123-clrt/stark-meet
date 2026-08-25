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
        // Palette reprise du template Bantec
        // ====================================================================
        // Deux partis pris donnent son caractère à ce système, et ils comptent
        // plus que les valeurs elles-mêmes :
        //
        //  · le texte n'est jamais noir mais BLEU NUIT (#051634). Sur fond
        //    clair, ça adoucit le contraste et rattache toute l'interface au
        //    primaire — c'est ce qui fait « posé » plutôt que « brut » ;
        //  · les gris sont légèrement BLEUTÉS (#f4f7fb), jamais neutres.
        brand: {
          50: '#EEF3FF',  // teinte de fond (puces, bandeaux d'information)
          500: '#0E59F2', // primaire
          600: '#0B46BF', // primaire au survol
        },
        // Jaune d'accent du template. Volontairement rare : il ne sert qu'à
        // souligner un élément unique par écran, sans quoi il perd sa fonction.
        accent: {
          50: '#FEFBE6',
          500: '#F8E559',
        },
        // Échelle de gris : texte, bordures et fonds d'interface.
        slate: {
          950: '#051634', // titres et texte principal — bleu nuit, pas du noir
          700: '#343434', // texte courant
          500: '#737373', // texte atténué, indications, désactivé
          200: '#E7E7E7', // bordures
          100: '#EEF1F7', // puces, remplissage au survol
          50: '#F4F7FB',  // fond de page, légèrement bleuté
        },
        surface: '#FFFFFF', // cartes, panneaux, barres
        canvas: '#EDF1F8',  // fond de la page réunion (plus soutenu)
        // Les tuiles vidéo restent sombres — c'est du contenu vidéo, pas une
        // surface d'interface. Le gris anthracite du template plutôt que du
        // noir : moins dur à côté des surfaces bleutées.
        stage: '#1C1E22',
        success: { 50: '#E7F8F1', 500: '#10B981' },
        warning: { 50: '#FEF4E3', 500: '#F59E0B' },
        error: { 50: '#FDECEC', 500: '#EF4444' },

      },
      fontFamily: {
        // Space Grotesk pour tout, titres comme corps de texte — c'est le choix
        // du template, et c'est ce qui lui donne son identité. Une seule famille
        // évite aussi le désaccord de rythme entre deux dessins différents.
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
      },
      letterSpacing: {
        // Nettement moins serré qu'avant. General Sans supportait -0,04em ;
        // Space Grotesk a des lettres plus larges et des contreformes ouvertes,
        // et le même resserrement les ferait se toucher dans les gros titres.
        display: '-0.02em',
        heading: '-0.01em',
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
        // Ombres larges et très diffuses, reprises du template : 70 px de flou
        // pour 8 % d'opacité. Elles décollent les cartes du fond sans jamais
        // dessiner de contour visible — c'est ce qui distingue une ombre « de
        // profondeur » d'une ombre « de contour ».
        'card-hover': '0 25px 70px rgba(5,22,52,0.08)',
        'brand-glow': '0 8px 24px rgba(14,89,242,0.28)',
        lg: '0 18px 50px rgba(5,22,52,0.10)',
        overlay: '0 30px 80px rgba(5,22,52,0.16)',
        focus: '0 0 0 3px rgba(14,89,242,0.14)',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0.6, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
