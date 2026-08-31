import { STATUS_META } from "../status";
import type { FileStatus } from "../types";

export default function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as FileStatus] ?? STATUS_META.unchecked;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-600" title={meta.description}>
      <span aria-hidden="true" className={"inline-block h-1.5 w-1.5 rounded-full " + meta.dot} />
      {meta.label}
    </span>
  );
}
