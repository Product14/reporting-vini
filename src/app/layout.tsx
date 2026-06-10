import type { Metadata } from "next";
import { Geist, Geist_Mono, DM_Mono } from "next/font/google";
import { NewCampaignProvider } from "@/context/NewCampaignContext";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const dmMono = DM_Mono({
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Spyne — Reporting",
  description: "Embeddable reporting surface (iframe). Pass ?team_id=… to scope to a rooftop.",
};

// Root layout for the embeddable reporting app. No global chrome (Header/Sidebar) —
// this is meant to be iframed inside the host product's reports tab. The reports
// surface lives under /reports and is wrapped by its own ScenarioProvider layout.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${dmMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <NewCampaignProvider>{children}</NewCampaignProvider>
        <Analytics />
      </body>
    </html>
  );
}
