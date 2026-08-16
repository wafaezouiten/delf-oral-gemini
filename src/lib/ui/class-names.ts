/**
 * Conditional class joining, and nothing else.
 *
 * The reference implementation reaches for `cn` (clsx + tailwind-merge) in every
 * component. The merge half of that is not reproduced here: it exists to let a
 * caller override a component's own utility with a conflicting one from a
 * `className` prop, and no component in this project takes a `className` it then
 * has to lose a specificity fight with — the two that come close (`BandScale`,
 * `Notice`) take a tone, not a class string. Shipping a 6 kB parser of Tailwind's
 * class grammar to resolve conflicts nobody creates would be paying for the
 * problem rather than the solution.
 *
 * What is left is the half that is used constantly: drop the falsy branches and
 * join the rest. Written out because the alternative — a template literal with
 * six ternaries in it — is where the class strings in this codebase were
 * starting to become unreadable.
 */

export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
