export function formatBytes(n: number | null): string {
  if (n === null || !isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

export function formatDuration(s: number | null): string {
  if (s === null || !isFinite(s)) return "-";
  const totalMin = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    return h + "h " + (totalMin % 60) + "m";
  }
  return totalMin + "m " + String(sec).padStart(2, "0") + "s";
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

/** Relative time for tooltips-free display ("2h ago"); pair with formatWhen for the exact stamp. */
export function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  const hours = Math.round(min / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 60) return days + "d ago";
  return Math.round(days / 30) + "mo ago";
}
