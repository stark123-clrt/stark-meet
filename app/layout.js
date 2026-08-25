import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Space Grotesk, police unique du template Bantec — titres comme corps de texte.
//
// Elle remplace le duo DM Sans + General Sans. Deux gains au passage : une seule
// famille à charger au lieu de deux, et la disparition des quatre fichiers
// `.woff2` auto-hébergés, General Sans n'étant pas distribué par Google Fonts
// alors que Space Grotesk l'est.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata = {
  title: 'Stark Meet',
  description: 'Vos réunions, sans friction.',
};

export default function RootLayout({ children }) {
  // `--font-display` pointe sur la même police que `--font-sans` : les classes
  // `font-display` déjà posées dans les composants restent valables, sans avoir
  // à les reprendre une par une.
  return (
    <html
      lang="fr"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable}`}
      style={{ '--font-display': 'var(--font-sans)' }}
    >
      <body>{children}</body>
    </html>
  );
}
