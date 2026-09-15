import { COMPETENCY_MAX } from "@/lib/delf/constants";

/** Accent- and case-insensitive, so "telelravail" finds « télétravail ». */
export function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * The catalogue under a search: a sujet matches on its title or on a word of
 * its document déclencheur. An empty query is the whole catalogue, in order.
 */
export function filterSujets<T extends { title: string; topic: { document: string } }>(
  sujets: readonly T[],
  query: string,
): readonly T[] {
  const needle = normalise(query);
  if (!needle) return sujets;
  return sujets.filter(
    (sujet) =>
      normalise(sujet.title).includes(needle) || normalise(sujet.topic.document).includes(needle),
  );
}

/**
 * The live count under the search box: counted rather than merely re-rendered,
 * because a candidate filtering a list they cannot see needs to hear that it
 * changed.
 */
export function resultCount(query: string, shown: number, total: number): string {
  if (!query) return `${total} sujets`;
  return `${shown} sujet${shown > 1 ? "s" : ""} sur ${total}`;
}

/** The masthead's banded strip of facts. */
export function catalogueFacts(total: number): string[] {
  return [`${total} sujets publiés`, "Examinateur IA", `Correction /${COMPETENCY_MAX}`];
}
