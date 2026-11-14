import type { SVGProps } from "react";

/**
 * The product's icons: authored inline SVGs, one stroke weight (1.5), one box
 * (14px), currentColor. Unicode glyphs are not icons.
 */
function Icon({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 14 14"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.25 7 8.75l3.5-3.5" />
    </Icon>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 3.5l7 7m0-7-7 7" />
    </Icon>
  );
}

export function MoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="3.25" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7" cy="10.75" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** 7px-tall triangle used beside sorted table headers. */ export function SortCaret({
  direction
}: {
  direction: "asc" | "desc" | null;
}) {
  if (direction === null) {
    return (
      <span aria-hidden="true" className="inline-flex flex-col gap-[2px] text-neutral-400">
        <span className="block h-0 w-0 border-x-[3.5px] border-b-[4px] border-x-transparent border-b-current" />
        <span className="block h-0 w-0 border-x-[3.5px] border-t-[4px] border-x-transparent border-t-current" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={
        "block h-0 w-0 border-x-[3.5px] border-x-transparent " +
        (direction === "asc" ? "border-b-[4px] border-b-current" : "border-t-[4px] border-t-current")
      }
    />
  );
}
