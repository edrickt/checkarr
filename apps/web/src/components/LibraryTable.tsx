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
import { DropdownButton, type MenuItemSpec } from "../ui/Menu";
import { useToast } from "../ui/Toast";

type SortColumn = Exclude<LibrarySort, "">;

const COLUMNS: { key: string; label: string; sortable?: SortColumn }[] = [
  { key: "status", label: "Status", sortable: "status" },
  { key: "title", label: "Title", sortable: "title" },
  { key: "quality", label: "Quality" },
  { key: "size", label: "Size", sortable: "size" },
  { key: "duration", label: "Duration" },
  { key: "source", label: "Source" },
  { key: "checked", label: "Checked", sortable: "checked" }
];

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

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));

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

  const onSort = (col: SortColumn) => {
    const dir: SortDir =
      query.sort === col ? (query.dir === "asc" ? "desc" : "asc") : col === "title" ? "asc" : "desc";
    onQueryChange({ sort: col, dir, page: 1 });
  };

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

  const rowMenu = (f: MediaFile): MenuItemSpec[] => [
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
      key: "delete",
      label: "Delete & re-search",
      description:
        f.path === null
          ? "Nothing to delete at the *arr yet"
          : "Delete at " + f.sourceName + " and queue a replacement",
      disabled: f.path === null,
      danger: true,
      onSelect: () => {
        void confirmDelete(f);
      }
    }
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search title or path..."
          className="w-64"
          aria-label="Search title or path"
        />
        <Select
          aria-label="Filter by status"
          value={query.status}
          onChange={(e) => onQueryChange({ status: e.target.value, page: 1 })}
          className="capitalize"
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
        >
          <option value="">All sources</option>
          {(sources.data?.sources ?? []).map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="ml-auto text-xs text-neutral-400">{total} files</div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              {COLUMNS.map((c) =>
                c.sortable ? (
                  <th
                    key={c.key}
                    aria-sort={
                      query.sort === c.sortable ? (query.dir === "asc" ? "ascending" : "descending") : "none"
                    }
                    className="px-3 py-2 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => onSort(c.sortable as SortColumn)}
                      className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-neutral-900"
                    >
                      {c.label}
                      <span aria-hidden="true" className="text-[10px]">
                        {query.sort === c.sortable ? (query.dir === "asc" ? "\u25B2" : "\u25BC") : "\u2195"}
                      </span>
                    </button>
                  </th>
                ) : (
                  <th key={c.key} className="px-3 py-2 font-medium">
                    {c.label}
                  </th>
                )
              )}
              <th className="px-3 py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {items.map((f) => (
              <tr
                key={f.id}
                className={
                  "cursor-pointer hover:bg-neutral-50 " +
                  (checkingId === f.id || purgingId === f.id ? "opacity-60" : "")
                }
                onClick={() => setSelected(f)}
              >
                <td className="px-3 py-2">
                  <StatusBadge status={f.status} />
                </td>
                <td className="max-w-[22rem] px-3 py-2">
                  <div className="truncate">{f.title}</div>
                  {f.subtitle && <div className="truncate text-xs text-neutral-400">{f.subtitle}</div>}
                </td>
                <td className="px-3 py-2 text-neutral-500">{f.quality ?? "-"}</td>
                <td className="px-3 py-2 text-neutral-500">{formatBytes(f.sizeBytes)}</td>
                <td className="px-3 py-2 text-neutral-500">{formatDuration(f.durationS)}</td>
                <td className="px-3 py-2 text-neutral-500">{f.sourceName}</td>
                <td className="px-3 py-2 text-xs text-neutral-400" title={formatWhen(f.checkedAt)}>
                  {formatRelative(f.checkedAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                  {checkingId === f.id && <span className="mr-2 text-xs text-neutral-400">Checking...</span>}
                  {purgingId === f.id && <span className="mr-2 text-xs text-neutral-400">Deleting...</span>}
                  <DropdownButton
                    label="⋯"
                    ariaLabel={"Actions for " + f.title}
                    size="sm"
                    caret={false}
                    align="right"
                    menuClassName="w-60"
                    className="inline-block"
                    items={rowMenu(f)}
                  />
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-neutral-400">
                  {list.isError
                    ? "Could not load the library: " + ((list.error as Error)?.message ?? "unknown error")
                    : list.isLoading
                      ? "Loading..."
                      : "No files match. Adjust the filters, or sync your libraries from the Dashboard."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400">
        <span>
          Page {query.page} of {pageCount}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
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
