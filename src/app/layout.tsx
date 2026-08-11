import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { frFR } from "@clerk/localizations";

import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "DELF B2 · Production orale",
  description:
    "Simulateur d'épreuve orale DELF B2 : monologue suivi et débat avec un examinateur, puis évaluation sur 25 points.",
};

/**
 * Clerk v7 requires `<ClerkProvider>` INSIDE `<body>`, not wrapping `<html>`
 * (a breaking change from v6, which the reference project still uses). The
 * French localization is applied here so the auth screens match the rest of the
 * product; a candidate preparing a French exam should not meet English forms.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`${inter.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <ClerkProvider localization={frFR}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
