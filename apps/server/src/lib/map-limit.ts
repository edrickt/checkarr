/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving the
 * order of `items` in the result.
 *
 * Used wherever a *arr library needs one request per item (Sonarr episodes,
 * Radarr/Sonarr purges): a serial loop makes the wall time scale with the
 * library size, and an unbounded `Promise.all` would open hundreds of sockets
 * at once against a small *arr box.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
