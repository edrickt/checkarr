import type { ComponentProps } from "react";

export type ControlSize = "sm" | "md";

const BASE =
  "border border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 " +
  "focus:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-40";

const SIZES: Record<ControlSize, string> = {
  sm: "h-8 px-2 text-xs",
  md: "h-9 px-3 text-sm"
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
