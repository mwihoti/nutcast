import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nutcast: stream sats in ecash while you listen',
  description:
    'A Cashu Value4Value kit: stream sats with a budget and a pause, split them across a show, and let creators claim and cash out.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="testbar" role="note">
          Test mint only. Every balance on this page is <strong>test sats</strong> with no value.
        </div>
        {children}
        <footer className="foot">
          Nutcast is open source (MIT), built for Nut November 2026. Ecash is held by the mint: with a real
          mint, keep only small amounts and pick one you trust.
        </footer>
      </body>
    </html>
  );
}
