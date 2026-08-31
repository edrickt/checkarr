export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={(checked ? "Enabled" : "Disabled") + " - sync and actions only run against enabled sources"}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
        (checked ? "border-neutral-900 bg-neutral-900" : "border-neutral-300 bg-neutral-200")
      }
    >
      <span
        aria-hidden="true"
        className={
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-[18px]" : "translate-x-[3px]")
        }
      />
    </button>
  );
}
