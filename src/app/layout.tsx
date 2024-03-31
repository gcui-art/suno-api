import type { Metadata } from "next";
import "../css/globals.css";
import "../css/app.css";
import { Analytics } from "@vercel/analytics/react"
import Head from 'next/head';

export const metadata: Metadata = {
  title: "Suno Songs Downloader",
  description: "Download suno.ai songs for free!",
  keywords: ["suno", "suno.ai", "music", "generation", "ai", "download", "free"],
  creator: "Blauker",
};

export default function RootLayout({ children, }: Readonly<{ children: React.ReactNode; }>) {
  return (
    <html lang="en">
      <Head>
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <body>
        <main>
          {children}
        </main>
        <Analytics />
      </body>
    </html>
  );
}
