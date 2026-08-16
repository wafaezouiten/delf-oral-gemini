import type { SVGProps } from "react";

/**
 * The glyphs the production orale screens need, drawn here.
 *
 * The reference implementation draws all of these with `@hugeicons/react` +
 * `@hugeicons/core-free-icons`, a pair this project does not have and is not
 * taking on: between them they are several megabytes of icon data to render
 * fourteen glyphs, on a product that until now shipped none at all and said so
 * on purpose — the connection badge's mark is a character precisely because "it
 * inherits the text colour, scales with the text, and cannot fail to load".
 *
 * That argument survives here, and this module is written to keep it. Every icon
 * is a stroke path on `currentColor` at `1.8`, sized from the class the caller
 * passes, so it inherits colour and scale exactly as the badge's `✕` does. The
 * difference is only that a microphone and a stop square are not characters
 * anyone can type.
 *
 * All of them are `aria-hidden`, without exception. An icon in this product is
 * never the only carrier of a meaning: the mic button has an accessible name
 * from `micCopy`, the notes toggle has `aria-label`, the criterion chevron sits
 * inside a button whose text is the criterion. That is the same rule the tokens
 * are under — colour never carries meaning alone — restated for shapes.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ className = "size-4", ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
      {...props}
    />
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 5 8 12l7 7" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 5 7 7-7 7" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4.8v14.4a.6.6 0 0 0 .92.5l11.3-7.2a.6.6 0 0 0 0-1l-11.3-7.2a.6.6 0 0 0-.92.5Z" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <path d="M12 18v3" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Icon>
  );
}

/** The spinner. Pair it with `animate-spin`; the gap is what makes it read. */
export function LoadingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17v3Z" />
      <path d="m15 7 2 2" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Icon>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.4 2.4 4.6-4.8" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16.2h.01" />
    </Icon>
  );
}

export function IdeaIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 17.5a5.5 5.5 0 1 1 5 0v1.2a1.3 1.3 0 0 1-1.3 1.3h-2.4a1.3 1.3 0 0 1-1.3-1.3v-1.2Z" />
      <path d="M10 20.8h4" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.5 4v4.2h-4.2" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Icon>
  );
}

/** The sujets catalogue: a sheet with lines on it, not a book. */
export function DocumentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5h7.5L19 9v11.5H6z" />
      <path d="M13.2 3.6V9H18.8" />
      <path d="M9 13h6M9 16.5h4" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.2V12l3 1.8" />
    </Icon>
  );
}

/** The correction's glyph: a grid with a mark in it, not a magic wand. */
export function GridCheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 9.5h17M9.5 9.5v11" />
      <path d="m12.6 15 1.8 1.8 3.2-3.4" />
    </Icon>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V6M17 20v-9" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Icon>
  );
}

export function ExitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M10 8 6 12l4 4" />
      <path d="M6 12h10" />
    </Icon>
  );
}
