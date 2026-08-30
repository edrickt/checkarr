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
