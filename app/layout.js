import { DM_Sans, JetBrains_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';

// Corps de texte et interface.
const dmSans = DM_Sans({
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

// Titres. General Sans est distribué par Fontshare, pas par Google Fonts :
// `next/font/google` ne peut donc pas le charger. Les woff2 sont auto-hébergés
// dans public/fonts — c'est ce qui évite la requête externe bloquante que
// l'`@import` du template imposait au premier rendu.
const generalSans = localFont({
  src: [
    { path: '../public/fonts/GeneralSans-400.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/GeneralSans-500.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/GeneralSans-600.woff2', weight: '600', style: 'normal' },
    { path: '../public/fonts/GeneralSans-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
});

export const metadata = {
  title: 'Stark Meet',
  description: 'Vos réunions, sans friction.',
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="fr"
      className={`${dmSans.variable} ${jetBrainsMono.variable} ${generalSans.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
