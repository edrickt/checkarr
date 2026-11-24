import type { ComponentProps } from "react";

export type ControlSize = "sm" | "md";

const BASE =
  "border border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 " +
  "focus:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-40";

// Phones get 40px controls with 16px text: iOS Safari zooms the page when a
// focused field is smaller than that, and never zooms back out. The desktop
// sizes below sm keep the dense operate-surface scale.
const SIZES: Record<ControlSize, string> = {
  sm: "h-10 px-2 text-base sm:h-8 sm:px-2 sm:text-xs",
  md: "h-10 px-3 text-base sm:h-9 sm:px-3 sm:text-sm"
};

function controlClass(size: ControlSize, className: string): string {
  return BASE + " " + SIZES[size] + " " + className;
}

export function Input({
  size = "md",
  className = "",
  ...rest
}: Omit<ComponentProps<"input">, "size"> & { size?: ControlSize }) {
  return <input {...rest} className={controlClass(size, className)} />;
}

/** Native select: familiar platform affordance, one border/height with inputs. */
export function Select({
  size = "md",
  className = "",
  ...rest
}: Omit<ComponentProps<"select">, "size"> & { size?: ControlSize }) {
  return <select {...rest} className={controlClass(size, "pr-8 " + className)} />;
}

/** Multi-line input (one entry per line), same border/focus tokens as Input. */
export function Textarea({ className = "", ...rest }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...rest}
      className={BASE + " min-h-[5.5rem] resize-y px-3 py-2 text-base sm:text-xs " + className}
    />
  );
}
