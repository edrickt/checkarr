import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/utils";

describe("formatDuration", () => {
  it("formats null as a dash", () => {
    expect(formatDuration(null)).toBe("-");
  });

  it("formats whole minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0m 00s");
    expect(formatDuration(65)).toBe("1m 05s");
  });

  it("carries a rounded-up 60s into the next minute", () => {
    expect(formatDuration(119.6)).toBe("2m 00s");
    expect(formatDuration(59.5)).toBe("1m 00s");
  });

  it("carries into hours instead of printing 60s", () => {
    expect(formatDuration(3599.6)).toBe("1h 0m");
    expect(formatDuration(3661)).toBe("1h 1m");
  });
});
