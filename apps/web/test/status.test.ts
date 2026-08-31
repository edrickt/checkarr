import { describe, expect, it } from "vitest";
import { PURGEABLE_STATUSES, SCAN_SCOPES, STATUS_META, STATUS_ORDER } from "../src/status";
import type { FileStatus } from "../src/types";

const ALL: FileStatus[] = ["unchecked", "healthy", "suspect", "corrupt", "missing", "unreachable", "purged"];

describe("status metadata", () => {
  it("has metadata for every status and no extras", () => {
    expect(Object.keys(STATUS_META).sort()).toEqual([...ALL].sort());
  });

  it("uses one canonical order: problems first, healthy last", () => {
    expect(STATUS_ORDER[0]).toBe("corrupt");
    expect(STATUS_ORDER[STATUS_ORDER.length - 1]).toBe("healthy");
    expect(new Set(STATUS_ORDER).size).toBe(STATUS_ORDER.length);
  });

  it("labels never say Unscanned (the old name)", () => {
    for (const meta of Object.values(STATUS_META)) {
      expect(meta.label.toLowerCase()).not.toContain("unscanned");
    }
  });

  it("scan scopes cover every status except healthy, in canonical order", () => {
    expect(SCAN_SCOPES).toEqual(STATUS_ORDER.filter((s) => s !== "healthy"));
    expect(SCAN_SCOPES).not.toContain("healthy");
  });

  it("purgeable statuses are exactly the ones with files on disk", () => {
    expect([...PURGEABLE_STATUSES]).toEqual(["corrupt", "suspect", "unreachable"]);
  });
});
