import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { AppProvider } from "./providers";
import { AppShell } from "./shell";

/**
 * next/font self-hosts these at build time, so they are served from our own
 * origin and the CSP's `font-src 'self'` holds. (The old app pulled a Google
 * Fonts stylesheet cross-origin — render-blocking and CSP-violating.)
 */
/**
 * Fraunces rather than Instrument Serif.
 *
 * Instrument Serif is a condensed display face declaring an ascender of ~118%
 * of the em, so headings read as vertically stretched. Fraunces is the opposite
 * on both counts — generous width and a large x-height — and its optical-size
 * axis keeps display sizes from looking spindly. SOFT/WONK add warmth without
 * tipping into novelty.
 */
const display = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK"],
  display: "swap",
});

const sans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Focus Log",
  description: "A private ledger of attention.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0a09",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <AppProvider>
          <AppShell>{children}</AppShell>
        </AppProvider>
      </body>
    </html>
  );
}
