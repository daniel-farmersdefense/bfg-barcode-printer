import '../styles/globals.css';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export default function App({ Component, pageProps }) {
  return (
    <main className={`${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
      <Component {...pageProps} />
    </main>
  );
}
