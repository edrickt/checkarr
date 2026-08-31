import { useCallback, useEffect, useState } from "react";
import { isFileStatus } from "./status";

export type Tab = "dashboard" | "library" | "settings";

export type LibrarySort = "" | "status" | "title" | "size" | "checked";
export type SortDir = "asc" | "desc";

export interface LibraryQuery {
  /** "" = all statuses. */
  status: string;
  /** "" = all sources, otherwise a source id. */
  sourceId: string;
  q: string;
  page: number;
  pageSize: number;
  sort: LibrarySort;
  dir: SortDir;
}

export interface Route {
  tab: Tab;
  /** Dashboard server scope: "" = all servers, otherwise a source id. */
  scope: string;
  library: LibraryQuery;
}

const TABS: readonly string[] = ["dashboard", "library", "settings"];
const PAGE_SIZES = [25, 50, 100, 200];
const SORTS: readonly string[] = ["", "status", "title", "size", "checked"];
const DEFAULT_PAGE_SIZE = 50;

function digits(value: string | null): string {
  return value !== null && /^\d+$/.test(value) ? value : "";
}

export function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const tab = TABS.includes(path) ? (path as Tab) : "dashboard";
  const pageRaw = Number(params.get("page"));
  const pageSizeRaw = Number(params.get("pageSize"));
  const sortRaw = params.get("sort") ?? "";
  const statusRaw = params.get("status");
  return {
    tab,
    scope: digits(params.get("server")),
    library: {
      status: isFileStatus(statusRaw) ? statusRaw : "",
      sourceId: digits(params.get("sourceId")),
      q: params.get("q") ?? "",
      page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
      pageSize: PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE,
      sort: (SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as LibrarySort) : "",
      dir: params.get("dir") === "asc" ? "asc" : "desc"
    }
  };
}

/** Omit default values so hashes stay short: #/library?status=corrupt&server=2. */
export function serializeRoute(r: Route): string {
  const params = new URLSearchParams();
  if (r.scope) params.set("server", r.scope);
  if (r.library.status) params.set("status", r.library.status);
  if (r.library.sourceId) params.set("sourceId", r.library.sourceId);
  if (r.library.q) params.set("q", r.library.q);
  if (r.library.page > 1) params.set("page", String(r.library.page));
  if (r.library.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(r.library.pageSize));
  if (r.library.sort) params.set("sort", r.library.sort);
  if (r.library.sort && r.library.dir === "asc") params.set("dir", "asc");
  const qs = params.toString();
  return "/" + r.tab + (qs ? "?" + qs : "");
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /**
   * Tab switches push a history entry; in-page param updates replace it, so
   * Back leaves the page instead of replaying every filter keystroke.
   */
  const navigate = useCallback((patch: (r: Route) => Route, opts?: { replace?: boolean }) => {
    const next = serializeRoute(patch(parseHash()));
    const target = "#" + next;
    if (opts?.replace) {
      history.replaceState(null, "", target);
      setRoute(parseHash());
    } else if (window.location.hash !== target) {
      window.location.hash = next;
    }
  }, []);

  return { route, navigate };
}
