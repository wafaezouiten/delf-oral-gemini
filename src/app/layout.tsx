import type { Metadata } from "next";
import { Inter, Spectral } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { frFR } from "@clerk/localizations";

import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

/**
 * The display face, used for headings, the subject document and the /25.
 *
 * A serif because the two things it sets are the two things the candidate is
 * meant to read as printed matter rather than as an interface: the document
 * déclencheur, which on the day arrives on paper, and the grille, which is a
 * corrector's grid. Spectral is a French-designed text serif with the latin-ext
 * coverage the accented copy needs; the weights are declared because
 * `next/font` only downloads what is asked for.
 */
const spectral = Spectral({
  variable: "--font-spectral",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

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
    <html
      lang="fr"
      className={`${inter.variable} ${spectral.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <ClerkProvider localization={frFR}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
