import { describe, expect, it } from "vitest";
import { applyPathMappings } from "../src/lib/paths.js";

describe("applyPathMappings", () => {
  it("rewrites a matching prefix", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/movies/Big (2020)/file.mkv", mappings)).toBe("/data/movies/Big (2020)/file.mkv");
  });
  it("first match wins", () => {
    const mappings = [
      { match: "/movies", replace: "/first" },
      { match: "/movies", replace: "/second" }
    ];
    expect(applyPathMappings("/movies/file.mkv", mappings)).toBe("/first/file.mkv");
  });
  it("ignores non-matching paths", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/tv/show/file.mkv", mappings)).toBe("/tv/show/file.mkv");
  });
  it("respects prefix boundaries", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/movies2/file.mkv", mappings)).toBe("/movies2/file.mkv");
  });
  it("strips trailing slashes from rules", () => {
    const mappings = [{ match: "/movies/", replace: "/data/movies/" }];
    expect(applyPathMappings("/movies/file.mkv", mappings)).toBe("/data/movies/file.mkv");
  });
  it("handles an exact match", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/movies", mappings)).toBe("/data/movies");
  });
  it("rewrites windows-style paths to posix", () => {
    const mappings = [{ match: "E:/Movies", replace: "/Volumes/movies" }];
    expect(applyPathMappings("E:\\Movies\\Big (2020)\\file.mkv", mappings)).toBe("/Volumes/movies/Big (2020)/file.mkv");
  });
  it("accepts match rules written with backslashes", () => {
    const mappings = [{ match: "E:\\Movies", replace: "/Volumes/movies" }];
    expect(applyPathMappings("E:\\Movies\\Big (2020)\\file.mkv", mappings)).toBe("/Volumes/movies/Big (2020)/file.mkv");
  });
  it("respects prefix boundaries on normalized windows paths", () => {
    const mappings = [{ match: "E:/Movies", replace: "/Volumes/movies" }];
    expect(applyPathMappings("E:\\Movies2\\file.mkv", mappings)).toBe("E:\\Movies2\\file.mkv");
  });
  it("passes unmatched windows paths through unchanged", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("D:\\TV Show\\s01e01.mkv", mappings)).toBe("D:\\TV Show\\s01e01.mkv");
  });
});
