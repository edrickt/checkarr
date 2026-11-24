import fs from "node:fs";
import path from "node:path";
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

/** Why a media path was refused before a single byte was read. */
export type MediaPathRejection = "invalid-path" | "outside-media-roots";

export class MediaPathError extends Error {
  readonly code: MediaPathRejection;

  constructor(code: MediaPathRejection, message: string) {
    super(message);
    this.name = "MediaPathError";
    this.code = code;
  }
}

function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((segment) => segment === "..");
}

function isInsideAny(p: string, roots: string[]): boolean {
  return roots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return p === root || p.startsWith(prefix);
  });
}

/**
 * Resolve an *arr-reported path to the local file Checkarr may read.
 *
 * The reported path is untrusted: it comes from the *arr API (or from whatever
 * answers at the configured base URL) and is only rewritten by the operator's
 * prefix mappings. Without confinement this function is an arbitrary-file
 * reader for the server user, reachable through the unauthenticated stream
 * endpoint and through ffmpeg.
 *
 * - The mapped path must be absolute, contain no `..` segment and no NUL.
 * - When at least one media root is configured, the *real* path (fs.realpath,
 *   so a symlink planted in the media folder cannot point outside it) must sit
 *   inside one of those roots. Roots are realpath'd too, and a root that does
 *   not exist on this host allows nothing.
 * - With no media root configured the path is returned as-is: that is the
 *   historical behaviour installations upgraded from 1.1.x get until they list
 *   their media roots (see README "Media roots"). The `..`/relative checks
 *   apply either way.
 *
 * fs errors (ENOENT, EACCES) propagate so callers keep their own verdicts.
 */
export async function resolveMediaPath(
  reported: string,
  mappings: PathMapping[],
  mediaRoots: string[]
): Promise<string> {
  const local = applyPathMappings(reported, mappings);
  if (local.includes("\0") || !path.isAbsolute(local) || hasParentSegment(local)) {
    throw new MediaPathError(
      "invalid-path",
      "refusing media path '" + local + "': not an absolute path without '..'"
    );
  }
  if (mediaRoots.length === 0) return local;

  // Decide containment on the normalized path first, so an out-of-root path is
  // refused with that message even when it does not exist (no ENOENT race and
  // no fs call for a path we are not going to read anyway).
  if (
    !isInsideAny(
      path.resolve(local),
      mediaRoots.map((root) => path.resolve(root))
    )
  ) {
    throw new MediaPathError(
      "outside-media-roots",
      "refusing '" + local + "': outside the configured media roots (" + mediaRoots.join(", ") + ")"
    );
  }

  // Then resolve symlinks on both sides: a link inside a root must not point the
  // reader at a file outside it. A path that does not exist throws ENOENT here,
  // which the callers already map to their own verdicts.
  const real = await fs.promises.realpath(local);
  const realRoots: string[] = [];
  for (const root of mediaRoots) {
    try {
      realRoots.push(await fs.promises.realpath(root));
    } catch {
      // A root that is not on this host cannot allow anything.
    }
  }
  if (!isInsideAny(real, realRoots)) {
    throw new MediaPathError(
      "outside-media-roots",
      "refusing '" + local + "': resolves outside the configured media roots (" + mediaRoots.join(", ") + ")"
    );
  }
  return real;
}
