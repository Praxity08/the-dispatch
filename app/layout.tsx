import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./dispatch-theme.css";
import { ThemeToggle, themeBootScript } from "./theme-toggle";

export const metadata: Metadata = {
  title: "The Dispatch — Newsletter Engine",
  description: "Newsletter intelligence and delivery pipeline for The Dispatch",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The boot script sets data-theme before React hydrates, hence suppressHydrationWarning.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        <ThemeToggle floating />
      </body>
    </html>
  );
}
