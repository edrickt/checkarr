import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { MediaFile } from "../types";
import { useScanState, useSources } from "../hooks";
import type { LibraryQuery, LibrarySort, SortDir } from "../router";
import { STATUS_META, STATUS_ORDER } from "../status";
import { formatBytes, formatDuration, formatRelative, formatWhen } from "../utils";
import StatusBadge from "./StatusBadge";
import DetailModal from "./DetailModal";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/controls";
import { useConfirm } from "../ui/ConfirmDialog";
import { ErrorBanner } from "../ui/ErrorBanner";
import { MoreIcon, SortCaret } from "../ui/icons";
import { DropdownButton, type MenuItemSpec } from "../ui/Menu";
import { useToast } from "../ui/Toast";

type SortColumn = Exclude<LibrarySort, "">;

/** Delete & re-search removes bytes, so it only applies while a file is on disk. */
const ON_DISK_STATUSES = new Set(["corrupt", "suspect", "unreachable", "healthy", "unchecked"]);

function hasFileOnDisk(f: MediaFile): boolean {
  return f.path !== null && ON_DISK_STATUSES.has(f.status);
}

/** Rows waiting on the *arr for a download: their action is a new search, not a delete. */
function canSearch(f: MediaFile): boolean {
  return f.status === "missing" || f.status === "purged";
}

const COLUMNS: { key: string; label: string; sortable?: SortColumn; numeric?: boolean }[] = [
  { key: "status", label: "Status", sortable: "status" },
  { key: "title", label: "Title", sortable: "title" },
  { key: "quality", label: "Quality" },
  { key: "size", label: "Size", sortable: "size", numeric: true },
  { key: "duration", label: "Duration", numeric: true },
  { key: "source", label: "Source" },
  { key: "checked", label: "Checked", sortable: "checked", numeric: true }
];

const HEADER_BUTTON =
  "inline-flex items-center gap-1.5 text-xs font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";

export default function LibraryTable({
  query,
  onQueryChange
}: {
  /** Lives in the URL: filters survive tab switches, reloads and back/forward. */
  query: LibraryQuery;
  onQueryChange: (patch: Partial<LibraryQuery>) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<MediaFile | null>(null);
  const [qInput, setQInput] = useState(query.q);

  // Debounce the search box, and follow external query changes (a dashboard
  // status card deep link resets the search to ""). The callback lives in a
  // ref so scan polling re-renders (which recreate the inline onQueryChange
  // in App) do not reset the 300ms timer mid-keystroke.
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  useEffect(() => {
    const t = setTimeout(() => {
      if (qInput !== query.q) onQueryChangeRef.current({ q: qInput, page: 1 });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, query.q]);
  useEffect(() => setQInput(query.q), [query.q]);

  const sources = useSources();
  const scan = useScanState();

  const list = useQuery({
    queryKey: [
      "files",
      query.status,
      query.sourceId,
      query.q,
      query.page,
      query.pageSize,
      query.sort,
      query.dir
    ],
    queryFn: () =>
      api.files({
        status: query.status || null,
        sourceId: query.sourceId ? Number(query.sourceId) : null,
        q: query.q || undefined,
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort || undefined,
        dir: query.dir
      }),
    // Poll gently while a scan is running so verdicts stream into the table.
    refetchInterval: scan.data?.active ? 5000 : false
  });

  const recheck = useMutation({
    mutationFn: (id: number) => api.recheck(id),
    onSuccess: (r) => {
      toast.success("Re-check finished - " + (STATUS_META[r.status]?.label ?? r.status));
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => toast.error("Re-check failed: " + err.message)
  });

  const purgeOne = useMutation({
    mutationFn: (id: number) => api.purgeFile(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      if (data.total === 0) {
        const r = data.results[0];
        toast.error(
          "Nothing deleted at " +
            (r?.name ?? "the *arr") +
            (r && r.errors.length > 0 ? " - " + r.errors[0] : " - the file may already be gone")
        );
      } else {
        toast.success("Deleted " + data.total + " file(s) and queued a replacement search");
      }
    },
    onError: (err: Error) => toast.error("Delete failed: " + err.message)
  });

  // Queue a search at the *arr for one missing/purged row. The API syncs the
  // item first, so a replacement that already landed is picked up instead.
  const researchOne = useMutation({
    mutationFn: (f: MediaFile) => api.researchFile(f.id),
    onSuccess: (r, f) => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      if (r.searched > 0) {
        const prefix = f.status === "purged" ? "Queued a replacement search at " : "Queued a search at ";
        toast.success(prefix + r.name + " for '" + f.title + "'.");
      } else {
        toast.error(
          "Could not queue a search at " + r.name + (r.errors.length > 0 ? " - " + r.errors[0] : "")
        );
      }
    },
    onError: (err: Error) => toast.error("Search failed: " + err.message)
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const filtered = query.q !== "" || query.status !== "" || query.sourceId !== "";

  useEffect(() => {
    // Deleting the last row of the last page (or a filter shrinking the result
    // set) leaves the page pointer past the end: clamp instead of showing a
    // permanently empty table. Only clamp once the listing for THIS query has
    // loaded - while it is still loading there is no data yet, and clamping
    // then would bounce every deep link and Next click back to page 1.
    if (!list.data) return;
    const loadedPageCount = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    if (query.page > loadedPageCount) onQueryChangeRef.current({ page: loadedPageCount });
  }, [list.data, query.page]);

  const checkingId = recheck.isPending && typeof recheck.variables === "number" ? recheck.variables : null;
  const purgingId = purgeOne.isPending && typeof purgeOne.variables === "number" ? purgeOne.variables : null;
  const researchingId = researchOne.isPending ? (researchOne.variables?.id ?? null) : null;

  const onSort = (col: SortColumn) => {
    const dir: SortDir =
      query.sort === col ? (query.dir === "asc" ? "desc" : "asc") : col === "title" ? "asc" : "desc";
    onQueryChange({ sort: col, dir, page: 1 });
  };

  const clearFilters = () => onQueryChange({ q: "", status: "", sourceId: "", page: 1 });

  const confirmDelete = async (f: MediaFile) => {
    const ok = await confirm({
      title: "Delete '" + f.title + "'?",
      body:
        "The file is removed from disk at " +
        f.sourceName +
        " and a replacement search is queued.\n\nThis cannot be undone.",
      confirmLabel: "Delete",
      danger: true
    });
    if (ok) purgeOne.mutate(f.id);
  };

  const rowMenu = (f: MediaFile): MenuItemSpec[] => {
    const searchable = canSearch(f);
    const deletable = hasFileOnDisk(f);
    return [
      {
        key: "details",
        label: "Details",
        description: "Player and ffmpeg findings",
        onSelect: () => setSelected(f)
      },
      {
        key: "recheck",
        label: "Re-check now",
        description: "Decode-probe this file again",
        onSelect: () => recheck.mutate(f.id)
      },
      {
        key: "search",
        label: "Search now",
        description: searchable
          ? "Ask " + f.sourceName + " to search for it again"
          : "Only missing and purged rows can be searched",
        disabled: !searchable,
        onSelect: () => researchOne.mutate(f)
      },
      {
        key: "delete",
        label: "Delete & re-search",
        description: deletable
          ? "Delete at " + f.sourceName + " and queue a replacement"
          : f.path === null
            ? "Nothing to delete at the *arr yet"
            : "Only files on disk can be deleted",
        disabled: !deletable,
        danger: true,
        onSelect: () => {
          void confirmDelete(f);
        }
      }
    ];
  };

  const rangeStart = total === 0 ? 0 : (query.page - 1) * query.pageSize + 1;
  const rangeEnd = Math.min(query.page * query.pageSize, total);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search title or path"
          className="min-w-56 flex-1"
          aria-label="Search title or path"
        />
        <Select
          aria-label="Filter by status"
          value={query.status}
          onChange={(e) => onQueryChange({ status: e.target.value, page: 1 })}
          className="w-40"
        >
          <option value="">All statuses</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by source"
          value={query.sourceId}
          onChange={(e) => onQueryChange({ sourceId: e.target.value, page: 1 })}
          className="w-48"
        >
          <option value="">All sources</option>
          {(sources.data?.sources ?? []).map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="ml-auto text-xs tabular-nums text-neutral-500">{total.toLocaleString()} files</div>
      </div>

      {list.isError && (
        <ErrorBanner>
          Could not load the library: {(list.error as Error)?.message ?? "unknown error"}
        </ErrorBanner>
      )}

      {/* The table is its own scroll container so the header can stick while
          rows scroll, and wide rows scroll horizontally without the page. */}
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Library files</caption>
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    c.sortable
                      ? query.sort === c.sortable
                        ? query.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                  className={
                    "h-9 whitespace-nowrap border-b border-neutral-200 px-3 text-xs font-medium " +
                    (c.numeric ? "text-right" : "text-left")
                  }
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.sortable as SortColumn)}
                      className={
                        HEADER_BUTTON +
                        " " +
                        (query.sort === c.sortable
                          ? "text-neutral-900"
                          : "text-neutral-500 hover:text-neutral-900")
                      }
                    >
                      {c.label}
                      <SortCaret direction={query.sort === c.sortable ? query.dir : null} />
                    </button>
                  ) : (
                    <span className="text-neutral-500">{c.label}</span>
                  )}
                </th>
              ))}
              <th
                scope="col"
                className="h-9 border-b border-neutral-200 px-3 text-right text-xs font-medium text-neutral-500"
              >
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr
                key={f.id}
                className={
                  "h-11 cursor-pointer border-b border-neutral-100 transition-colors hover:bg-neutral-50 " +
                  (checkingId === f.id || purgingId === f.id || researchingId === f.id ? "opacity-60" : "")
                }
                onClick={() => setSelected(f)}
              >
                <td className="px-3">
                  <StatusBadge status={f.status} />
                </td>
                <td className="max-w-[22rem] px-3">
                  <div className="truncate text-sm text-neutral-900">{f.title}</div>
                  {f.subtitle && <div className="truncate text-xs text-neutral-500">{f.subtitle}</div>}
                </td>
                <td className="px-3 text-sm text-neutral-700">{f.quality ?? "-"}</td>
                <td className="px-3 text-right text-sm tabular-nums text-neutral-700">
                  {formatBytes(f.sizeBytes)}
                </td>
                <td className="px-3 text-right text-sm tabular-nums text-neutral-700">
                  {formatDuration(f.durationS)}
                </td>
                <td className="px-3 text-sm text-neutral-700">{f.sourceName}</td>
                <td
                  className="px-3 text-right text-xs tabular-nums text-neutral-500"
                  title={formatWhen(f.checkedAt)}
                >
                  {formatRelative(f.checkedAt)}
                </td>
                <td className="whitespace-nowrap px-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {checkingId === f.id && <span className="mr-2 text-xs text-neutral-500">Checking...</span>}
                  {purgingId === f.id && <span className="mr-2 text-xs text-neutral-500">Deleting...</span>}
                  {researchingId === f.id && (
                    <span className="mr-2 text-xs text-neutral-500">Searching...</span>
                  )}
                  <DropdownButton
                    label={<MoreIcon />}
                    ariaLabel={"Actions for " + f.title}
                    variant="ghost"
                    size="sm"
                    caret={false}
                    align="right"
                    menuClassName="w-72"
                    className="align-middle"
                    items={rowMenu(f)}
                  />
                </td>
              </tr>
            ))}
            {items.length === 0 && !list.isError && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-10">
                  {list.isLoading ? (
                    <p className="text-center text-sm text-neutral-500">Loading...</p>
                  ) : filtered ? (
                    <div className="flex flex-col items-center gap-2 text-center">
                      <p className="text-sm font-medium text-neutral-900">No files match</p>
                      <p className="text-sm text-neutral-600">
                        Adjust the filters to see more of your library.
                      </p>
                      <Button variant="ghost" size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-center">
                      <p className="text-sm font-medium text-neutral-900">No files yet</p>
                      <p className="text-sm text-neutral-600">
                        Sync your libraries from the Dashboard to fill this table.
                      </p>
                      <a
                        href="#/dashboard"
                        className="text-sm text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
                      >
                        Go to the Dashboard
                      </a>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
        <span className="tabular-nums">
          {rangeStart + "\u2013" + rangeEnd + " of " + total.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5">
            Rows
            <Select
              size="sm"
              aria-label="Rows per page"
              value={String(query.pageSize)}
              onChange={(e) => onQueryChange({ pageSize: Number(e.target.value), page: 1 })}
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <Button
            size="sm"
            onClick={() => onQueryChange({ page: Math.max(1, query.page - 1) })}
            disabled={query.page <= 1}
          >
            Prev
          </Button>
          <Button
            size="sm"
            onClick={() => onQueryChange({ page: Math.min(pageCount, query.page + 1) })}
            disabled={query.page >= pageCount}
          >
            Next
          </Button>
        </div>
      </div>

      {selected && <DetailModal file={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
