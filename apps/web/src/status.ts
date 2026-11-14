import type { FileStatus } from "./types";

export interface StatusMeta {
  key: FileStatus;
  label: string;
  /** One-line meaning; used as tooltips and dropdown menu subtitles. */
  description: string;
  dot: string;
  text: string;
}

/**
 * The one canonical status order, used everywhere: dashboard cards, scan and
 * purge menus, library filters, badges. Problems first, healthy last - the
 * app's job is triage.
 */
export const STATUS_ORDER: FileStatus[] = [
  "corrupt",
  "suspect",
  "unreachable",
  "missing",
  "purged",
  "unchecked",
  "healthy"
];

export const STATUS_META: Record<FileStatus, StatusMeta> = {
  corrupt: {
    key: "corrupt",
    label: "Corrupt",
    description: "The file could not be decoded - container or stream data is broken.",
    dot: "bg-red-600",
    text: "text-red-600"
  },
  suspect: {
    key: "suspect",
    label: "Suspect",
    description: "Recoverable decode errors, unknown duration, or a timeout - it may still play.",
    dot: "bg-amber-600",
    text: "text-amber-600"
  },
  unreachable: {
    key: "unreachable",
    label: "Unreachable",
    description: "The file exists but is not readable (permissions).",
    dot: "bg-violet-600",
    text: "text-violet-600"
  },
  missing: {
    key: "missing",
    label: "Missing",
    description: "The *arr references a file that is gone, or a monitored item with no download yet.",
    dot: "bg-sky-600",
    text: "text-sky-600"
  },
  purged: {
    key: "purged",
    label: "Purged",
    description: "Deleted via Delete & re-search; waiting for the replacement download.",
    dot: "bg-fuchsia-600",
    text: "text-fuchsia-600"
  },
  unchecked: {
    key: "unchecked",
    label: "Unchecked",
    description: "Synced from the *arr but not checked yet.",
    dot: "bg-neutral-400",
    text: "text-neutral-500"
  },
  healthy: {
    key: "healthy",
    label: "Healthy",
    description: "Probe and all decode checks came back clean.",
    dot: "bg-emerald-600",
    text: "text-emerald-600"
  }
};

/** Scan scopes the server accepts, minus "all", in canonical order. */
export const SCAN_SCOPES = STATUS_ORDER.filter((s) => s !== "healthy") as Exclude<FileStatus, "healthy">[];

/**
 * Statuses Delete & re-search can target: they describe files that exist on
 * disk. missing/purged/unchecked have nothing to delete.
 */
export const PURGEABLE_STATUSES = ["corrupt", "suspect", "unreachable"] as const;

const KNOWN = new Set<string>(STATUS_ORDER);

export function isFileStatus(value: string | null): value is FileStatus {
  return value !== null && KNOWN.has(value);
}
