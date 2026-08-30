import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { MediaFile } from "../types";
import { formatBytes, formatDuration, formatWhen } from "../utils";
import StatusBadge from "./StatusBadge";
import DetailModal from "./DetailModal";

const STATUS_OPTIONS = ["", "healthy", "corrupt", "suspect", "missing", "unreachable", "unchecked"];

const INPUT = "border border-neutral-300 bg-white px-3 py-1.5 text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none";
const PAGE_BTN = "border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-40";

export default function LibraryTable({ initialStatus }: { initialStatus: string | null }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState(initialStatus ?? "");
  const [sourceId, setSourceId] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MediaFile | null>(null);
  const pageSize = 50;

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    setPage(1);
  }, [status, sourceId]);

  const sources = useQuery({ queryKey: ["sources"], queryFn: api.sources });
  const list = useQuery({
    queryKey: ["files", status, sourceId, q, page],
    queryFn: () =>
      api.files({
        status: status || null,
        sourceId: sourceId ? Number(sourceId) : null,
        q: q || undefined,
        page,
        pageSize,
        sort: "id",
        dir: "desc"
      })
  });

  const recheck = useMutation({
    mutationFn: (id: number) => api.recheck(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    }
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search title or path..."
          className={INPUT + " w-64"}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={INPUT + " capitalize"}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === "" ? "all statuses" : s}</option>
          ))}
        </select>
        <select
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          className={INPUT}
        >
          <option value="">all sources</option>
          {(sources.data?.sources ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <div className="ml-auto text-xs text-neutral-400">{total} files</div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
        <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-400">
          <tr>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Quality</th>
            <th className="px-3 py-2 font-medium">Size</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Checked</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {items.map((f) => (
            <tr key={f.id} className="cursor-pointer hover:bg-neutral-50" onClick={() => setSelected(f)}>
              <td className="px-3 py-2"><StatusBadge status={f.status} /></td>
              <td className="max-w-[22rem] px-3 py-2">
                <div className="truncate">{f.title}</div>
                {f.subtitle && <div className="truncate text-xs text-neutral-400">{f.subtitle}</div>}
              </td>
              <td className="px-3 py-2 text-neutral-500">{f.quality ?? "-"}</td>
              <td className="px-3 py-2 text-neutral-500">{formatBytes(f.sizeBytes)}</td>
              <td className="px-3 py-2 text-neutral-500">{formatDuration(f.durationS)}</td>
              <td className="px-3 py-2 text-neutral-500">{f.sourceName}</td>
              <td className="px-3 py-2 text-xs text-neutral-400">{formatWhen(f.checkedAt)}</td>
              <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setSelected(f)}
                  className="mr-3 text-xs text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline"
                  title="Open player and details"
                >
                  Play
                </button>
                <button
                  onClick={() => recheck.mutate(f.id)}
                  disabled={recheck.isPending}
                  className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline disabled:opacity-40"
                  title="Re-check this file now"
                >
                  Re-check
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-sm text-neutral-400">
                {list.isLoading ? "Loading..." : "No files match. Sync a library or adjust filters."}
              </td>
            </tr>
          )}
        </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>
          Page {page} of {pageCount}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className={PAGE_BTN}
          >
            Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount}
            className={PAGE_BTN}
          >
            Next
          </button>
        </div>
      </div>

      {recheck.error instanceof Error && (
        <div className="border border-red-300 px-3 py-2 text-xs text-red-700">{recheck.error.message}</div>
      )}

      {selected && <DetailModal file={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
