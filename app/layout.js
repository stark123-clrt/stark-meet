import './globals.css';

export const metadata = {
  title: 'Stark Meet',
  description: 'Visioconférence — sous votre contrôle.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
