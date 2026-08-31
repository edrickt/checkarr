import { afterEach, describe, expect, it } from "vitest";
import { parseHash, serializeRoute } from "../src/router";

afterEach(() => {
  history.replaceState(null, "", window.location.pathname);
});

describe("hash router", () => {
  it("defaults to the dashboard with default library params", () => {
    const r = parseHash();
    expect(r.tab).toBe("dashboard");
    expect(r.scope).toBe("");
    expect(r.library).toEqual({
      status: "",
      sourceId: "",
      q: "",
      page: 1,
      pageSize: 50,
      sort: "",
      dir: "desc"
    });
  });

  it("round-trips library filters through the hash", () => {
    history.replaceState(
      null,
      "",
      "#/library?status=corrupt&sourceId=2&q=star&page=3&pageSize=25&sort=size&dir=asc"
    );
    const r = parseHash();
    expect(r.tab).toBe("library");
    expect(r.library).toEqual({
      status: "corrupt",
      sourceId: "2",
      q: "star",
      page: 3,
      pageSize: 25,
      sort: "size",
      dir: "asc"
    });
    expect(serializeRoute(r)).toBe(
      "/library?status=corrupt&sourceId=2&q=star&page=3&pageSize=25&sort=size&dir=asc"
    );
  });

  it("keeps the dashboard server scope in the hash", () => {
    history.replaceState(null, "", "#/dashboard?server=7");
    expect(parseHash().scope).toBe("7");
    expect(serializeRoute(parseHash())).toBe("/dashboard?server=7");
  });

  it("normalizes garbage instead of crashing", () => {
    history.replaceState(
      null,
      "",
      "#/deep?status=bogus&page=0&pageSize=999&sort=deep&dir=diagonal&server=abc"
    );
    const r = parseHash();
    expect(r.tab).toBe("dashboard");
    expect(r.scope).toBe("");
    expect(r.library.status).toBe("");
    expect(r.library.page).toBe(1);
    expect(r.library.pageSize).toBe(50);
    expect(r.library.sort).toBe("");
    expect(r.library.dir).toBe("desc");
  });

  it("omits defaults when serializing so hashes stay short", () => {
    history.replaceState(null, "", "#/library?status=corrupt");
    expect(serializeRoute(parseHash())).toBe("/library?status=corrupt");
  });
});
