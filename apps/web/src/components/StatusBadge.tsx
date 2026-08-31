const DOTS: Record<string, string> = {
  healthy: "bg-emerald-500",
  suspect: "bg-amber-500",
  corrupt: "bg-red-500",
  missing: "bg-sky-500",
  unreachable: "bg-violet-500",
  purged: "bg-fuchsia-500",
  unchecked: "bg-neutral-300"
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs capitalize text-neutral-600">
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + (DOTS[status] ?? DOTS.unchecked)} />
      {status}
    </span>
  );
}
