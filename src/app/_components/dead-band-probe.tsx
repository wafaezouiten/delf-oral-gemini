"use client";

import { useEffect, useState } from "react";

/**
 * TEMPORARY diagnostic for #114 — delete before merging.
 *
 * When the document is taller than the viewport by more than a page's normal
 * flow explains, something is drawing the dead band. This probe finds it: it
 * looks for the elements whose layout bottom defines the document's bottom
 * edge, skipping anything whose overflow is contained by an inner scroll
 * container (those can extend past the viewport without extending the
 * document). The culprits get a red outline, and a red banner at the top of
 * the screen prints what they are — so a screenshot of the banner names the
 * element without opening devtools.
 */

interface Culprit {
  describe: string;
  chain: string;
}

function describeElement(el: Element): string {
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 6).join(".");
  const id = el.id ? `#${el.id}` : "";
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return `<${el.tagName.toLowerCase()}${id}${cls ? "." + cls : ""}> ${Math.round(r.width)}×${Math.round(r.height)}px pos:${cs.position} disp:${cs.display}`;
}

function findCulprits(): { summary: string; culprits: Culprit[] } | null {
  const doc = document.documentElement;
  const viewport = Math.max(doc.clientHeight, window.innerHeight);
  const overflow = doc.scrollHeight - viewport;
  if (overflow < 24) return null;

  const bottomEdge = doc.scrollHeight;
  const all = Array.from(document.querySelectorAll("*"));
  let hits = all.filter((el) => {
    if (el === doc || el === document.body) return false;
    if (el.id === "dead-band-probe") return false;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) return false;
    if (r.bottom + window.scrollY < bottomEdge - 8) return false;
    // Skip elements whose overflow is contained by an inner scroller: they
    // reach past the viewport without making the document taller. For an
    // absolutely-positioned element only its *containing-block* chain can clip
    // it — an unpositioned overflow-hidden ancestor cannot — so that chain is
    // the one walked; a fixed element is never document-clipped at all.
    const pos = getComputedStyle(el).position;
    if (pos === "fixed") return true;
    if (pos === "absolute") {
      for (
        let a = (el as HTMLElement).offsetParent as HTMLElement | null;
        a && a !== document.body && a !== doc;
        a = a.offsetParent as HTMLElement | null
      ) {
        const o = getComputedStyle(a).overflowY;
        if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
      }
      return true;
    }
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const o = getComputedStyle(a).overflowY;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
    }
    return true;
  });
  // Deepest only: drop any hit that contains another hit.
  hits = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));

  const culprits = hits.slice(0, 4).map((el) => {
    (el as HTMLElement).style.outline = "3px solid red";
    (el as HTMLElement).style.outlineOffset = "-3px";
    const chain: string[] = [];
    for (let a: Element | null = el, i = 0; a && a !== document.body && i < 4; a = a.parentElement, i++) {
      chain.push(describeElement(a));
    }
    return { describe: describeElement(el), chain: chain.join("  ⬅  ") };
  });

  return {
    summary: `document ${doc.scrollHeight}px vs viewport ${viewport}px — ${overflow}px de bande morte`,
    culprits,
  };
}

export function DeadBandProbe() {
  const [report, setReport] = useState<ReturnType<typeof findCulprits>>(null);

  useEffect(() => {
    const timers = [1000, 3000, 7000].map((ms) =>
      window.setTimeout(() => {
        const found = findCulprits();
        if (found) setReport(found);
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  if (!report) return null;

  return (
    <div
      id="dead-band-probe"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2147483647,
        background: "#a4132a",
        color: "#fff",
        font: "12px/1.5 monospace",
        padding: "8px 12px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {`DIAGNOSTIC #114 — ${report.summary}\n`}
      {report.culprits.length === 0
        ? "Aucun élément en flux ne dépasse : la hauteur vient d'ailleurs (marges ?)."
        : report.culprits.map((c, i) => `\n[${i + 1}] ${c.describe}\n     dans : ${c.chain}`).join("\n")}
    </div>
  );
}
