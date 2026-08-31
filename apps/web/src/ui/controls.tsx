import type { ComponentProps } from "react";

export type ControlSize = "sm" | "md";

const BASE =
  "border border-neutral-300 bg-white text-neutral-700 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40";

const SIZES: Record<ControlSize, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm"
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

export function Select({
  size = "md",
  className = "",
  ...rest
}: Omit<ComponentProps<"select">, "size"> & { size?: ControlSize }) {
  return <select {...rest} className={controlClass(size, className)} />;
}
