import { describe, expect, it } from "vitest";
import {
  classifyDecode,
  classifyProbe,
  excerpt,
  looksLikeMissing,
  progressShowsDecoding
} from "../src/lib/classify.js";

describe("classifyDecode", () => {
  it("fails on non-zero exit", () => {
    expect(classifyDecode({ code: 1, stderr: "Invalid data found", timedOut: false })).toBe("fail");
  });
  it("fails on negative exit with no signal information", () => {
    expect(classifyDecode({ code: -1, stderr: "", timedOut: false })).toBe("fail");
  });
  it("is inconclusive when killed by a signal (OOM killer, manual kill)", () => {
    expect(classifyDecode({ code: -1, stderr: "", timedOut: false, signaled: "SIGKILL" })).toBe("suspect");
  });
  it("is inconclusive on timeout", () => {
    expect(classifyDecode({ code: -1, stderr: "", timedOut: true })).toBe("suspect");
  });
  it("is inconclusive when exit 0 has stderr", () => {
    expect(classifyDecode({ code: 0, stderr: "Non-monotonous DTS", timedOut: false })).toBe("suspect");
  });
  it("passes when clean", () => {
    expect(classifyDecode({ code: 0, stderr: "", timedOut: false })).toBe("pass");
  });
});

describe("classifyProbe", () => {
  it("is corrupt when ffprobe reports invalid data", () => {
    expect(
      classifyProbe({ stderr: "/movies/a.mkv: Invalid data found when processing input", error: null })
    ).toBe("corrupt");
  });
  it("matches invalid data case-insensitively", () => {
    expect(
      classifyProbe({ stderr: "/movies/a.mkv: invalid data found when processing input", error: null })
    ).toBe("corrupt");
  });
  it("is suspect when ffprobe times out", () => {
    expect(classifyProbe({ stderr: "[checkarr] ffprobe timed out", error: null })).toBe("suspect");
  });
  it("is suspect on any other stderr without the invalid-data marker", () => {
    expect(classifyProbe({ stderr: "/movies/a.mkv: moov atom not found", error: null })).toBe("suspect");
  });
  it("is suspect when ffprobe could not run at all", () => {
    expect(classifyProbe({ stderr: "", error: "spawn ffprobe ENOENT" })).toBe("suspect");
  });
  it("is suspect on empty output", () => {
    expect(classifyProbe({ stderr: "", error: null })).toBe("suspect");
  });
});

describe("excerpt", () => {
  it("keeps the last lines only", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const out = excerpt(lines.join(String.fromCharCode(10)));
    expect(out).toContain("h");
    expect(out).not.toContain("a");
  });
  it("truncates very long lines", () => {
    const long = "x".repeat(1000);
    const out = excerpt(long);
    expect(out.length).toBeLessThan(300);
  });
});

describe("progressShowsDecoding", () => {
  it("is false for empty output", () => {
    expect(progressShowsDecoding("")).toBe(false);
  });
  it("is false when out_time never advanced", () => {
    expect(progressShowsDecoding("frame=0\nfps=0.0\nout_time_us=0\nprogress=continue\n")).toBe(false);
  });
  it("is true when out_time_us advanced", () => {
    expect(progressShowsDecoding("frame=40\nout_time_us=4000000\nprogress=end\n")).toBe(true);
  });
  it("is true when only out_time_ms advanced (legacy builds; microseconds)", () => {
    expect(progressShowsDecoding("frame=40\nout_time_ms=4000000\nprogress=end\n")).toBe(true);
  });
  it("is false for a bare progress=end with no decoded time", () => {
    expect(progressShowsDecoding("progress=end\n")).toBe(false);
  });
});

describe("looksLikeMissing", () => {
  it("matches ffmpeg/ffprobe ENOENT text", () => {
    expect(looksLikeMissing("/movies/a.mkv: No such file or directory")).toBe(true);
  });
  it("does not match other failures", () => {
    expect(looksLikeMissing("/movies/a.mkv: Invalid data found when processing input")).toBe(false);
    expect(looksLikeMissing("")).toBe(false);
  });
});
