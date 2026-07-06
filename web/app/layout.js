import './globals.css';

export const metadata = {
  title: 'NodeBBS — Dial In',
  description: 'Dial into an ANSI BBS from your browser, like it is 1994.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#05100a',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=VT323&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
