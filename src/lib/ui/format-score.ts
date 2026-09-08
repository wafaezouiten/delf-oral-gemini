/**
 * A /25 as the product prints it: always two digits — `00`, `01` … `09`, then
 * `10`–`25` untouched (#161).
 *
 * The padding is display only. Bands, floors and penalties keep comparing
 * numbers (`grille.ts`, `orale-rubric.ts` never see this string), so nothing
 * that decides can be confused by a leading zero — only what prints changes.
 *
 * It lives in `lib/ui` rather than beside `ScoreTag` because two of its callers
 * are view models that `node --test` loads (`dashboard-view.ts`,
 * `correction-notices.ts`), and a formatter stranded in a `.tsx` would drag JSX
 * into their test runs.
 */

/**
 * `7` → `07`, `12` → `12` — and the dashboard's fractional average pads its
 * whole part, `5.5` → `05.5`, so the tile's figure lines up with the marks
 * around it. Splitting on the decimal point rather than `padStart` on the whole
 * string, because `"5.5"` is already three characters and would pad to itself.
 */
export function formatScore25(score25: number): string {
  const [whole, fraction] = String(score25).split(".");
  const padded = whole.padStart(2, "0");
  return fraction === undefined ? padded : `${padded}.${fraction}`;
}
