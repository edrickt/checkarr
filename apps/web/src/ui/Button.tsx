import type { ComponentProps } from "react";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "dangerOutline";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 border font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  default:
    "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 hover:text-neutral-900 active:bg-neutral-50",
  primary:
    "border-neutral-900 bg-neutral-900 text-white hover:border-neutral-800 hover:bg-neutral-800 active:bg-neutral-950",
  ghost:
    "border-transparent bg-transparent text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 active:bg-neutral-200",
  danger: "border-red-700 bg-red-700 text-white hover:border-red-600 hover:bg-red-600 active:bg-red-800",
  dangerOutline:
    "border-neutral-300 bg-white text-red-700 hover:border-red-300 hover:bg-red-50 active:bg-red-100"
};

// 40px tall on phones (pointer: coarse targets), the dense h-8/h-9 at sm+.
const SIZES: Record<ButtonSize, string> = {
  sm: "h-10 px-3 text-sm sm:h-8 sm:px-2.5 sm:text-xs",
  md: "h-10 px-3 text-sm sm:h-9 sm:px-3 sm:text-sm"
};

export function Button({
  variant = "default",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type={type}
      className={BASE + " " + VARIANTS[variant] + " " + SIZES[size] + " " + className}
      {...rest}
    />
  );
}
