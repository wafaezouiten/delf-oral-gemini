import type { Metadata } from "next";
import { Inter, Spectral } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { frFR } from "@clerk/localizations";

import "./globals.css";
import { DeadBandProbe } from "@/app/_components/dead-band-probe";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

/**
 * The display face, used for headings, the subject document and the /25.
 *
 * A serif because the two things it sets are the two things the candidate is
 * meant to read as printed matter rather than as an interface: the document
 * déclencheur, which on the day arrives on paper, and the grille, which is a
 * corrector's grid. Spectral is a French-designed text serif with the latin-ext
 * coverage the accented copy needs; the weights are declared because
 * `next/font` only downloads what is asked for — and nothing more, which is why
 * there is no italic here. Nothing in this product is set in italic, and a face
 * that is asked for is a face that is fetched.
 */
const spectral = Spectral({
  variable: "--font-spectral",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
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
        {/* `display: contents`, so the wrapper is invisible to the body's flex
            layout and exists only to draw the line the dead-band guard in
            globals.css needs: inside #app is the product, and any other child
            of <body> is a squatter someone appended (#114). */}
        <div id="app" className="contents">
          <ClerkProvider localization={frFR}>{children}</ClerkProvider>
          {/* TEMPORARY #114 diagnostic — delete before merging. */}
          <DeadBandProbe />
        </div>
      </body>
    </html>
  );
}
