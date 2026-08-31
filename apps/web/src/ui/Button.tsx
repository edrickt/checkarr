import type { ComponentProps } from "react";

export type ButtonVariant = "default" | "primary" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  default: "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-900 hover:text-neutral-900",
  primary: "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700",
  danger: "border-neutral-300 bg-white text-neutral-700 hover:border-red-600 hover:text-red-600"
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm"
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
      className={
        "inline-flex items-center justify-center gap-1.5 border disabled:cursor-not-allowed disabled:opacity-40 " +
        VARIANTS[variant] +
        " " +
        SIZES[size] +
        " " +
        className
      }
      {...rest}
    />
  );
}
