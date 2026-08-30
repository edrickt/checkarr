import type { PathMapping } from "../settings.js";

function stripTrailingSlashes(s: string): string {
  let out = s;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Apply ordered prefix-rewrite rules (remote *arr path -> local path).
 * First matching rule wins; unmatched paths pass through unchanged.
 * Windows *arr hosts report paths with backslashes; both the path and the
 * match prefix are normalized to forward slashes so rules written either way
 * match, and rewritten local paths come out as clean POSIX paths.
 */
export function applyPathMappings(p: string, mappings: PathMapping[]): string {
  const norm = p.replace(/\\/g, "/");
  for (const m of mappings) {
    const match = stripTrailingSlashes(m.match.replace(/\\/g, "/"));
    if (match.length === 0) continue;
    if (norm === match || norm.startsWith(match + "/")) {
      const replace = stripTrailingSlashes(m.replace);
      return replace + norm.slice(match.length);
    }
  }
  return p;
}
