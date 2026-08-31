import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MediaFileDetail } from "../api";
import type { MediaFile } from "../types";
import { formatBytes, formatDuration, formatWhen } from "../utils";
import StatusBadge from "./StatusBadge";

const BTN =
  "border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 disabled:opacity-40";

export default function DetailModal({ file, onClose }: { file: MediaFile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const detail = useQuery({ queryKey: ["file", file.id], queryFn: () => api.file(file.id) });
  const f: MediaFileDetail = detail.data?.file ?? { ...file, probe: null };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const recheck = useMutation({
    mutationFn: () => api.recheck(file.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["file", file.id] });
    }
  });

  const jumpMiddle = () => {
    const v = videoRef.current;
    if (v && isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration / 2;
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={f.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto border border-neutral-200 bg-white p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{f.title}</h2>
            <p className="text-sm text-neutral-500">
              {f.subtitle ?? (f.kind === "movie" ? "Movie" : "Episode")}
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-neutral-400 hover:text-neutral-900">
            Close
          </button>
        </div>

        <video
          key={f.id}
          ref={videoRef}
          src={api.streamUrl(f.id)}
          controls
          preload="metadata"
          className="mb-3 max-h-72 w-full bg-black"
          onError={() =>
            setVideoError(
              "Browser playback failed. The codec may be unsupported by the browser (e.g. DTS audio) - the ffmpeg verdict is the source of truth."
            )
          }
          onLoadedMetadata={() => setVideoError(null)}
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={jumpMiddle} className={BTN}>
            Jump to middle
          </button>
          <button onClick={() => recheck.mutate()} disabled={recheck.isPending} className={BTN}>
            {recheck.isPending ? "Checking..." : "Re-check now"}
          </button>
          {recheck.data && (
            <span className="text-xs text-neutral-500">
              result: <span className="capitalize text-neutral-900">{recheck.data.status}</span>
            </span>
          )}
          {recheck.error instanceof Error && (
            <span className="text-xs text-red-600">{recheck.error.message}</span>
          )}
        </div>
        {videoError && (
          <div className="mb-3 border border-amber-300 px-3 py-2 text-xs text-amber-700">{videoError}</div>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={f.status} />
          </div>
          <div>
            <span className="text-neutral-400">source:</span> {f.sourceName} ({f.sourceType})
          </div>
          <div>
            <span className="text-neutral-400">quality:</span> {f.quality ?? "-"}
          </div>
          <div>
            <span className="text-neutral-400">size:</span> {formatBytes(f.sizeBytes)}
          </div>
          <div>
            <span className="text-neutral-400">duration:</span> {formatDuration(f.durationS)}
          </div>
          <div>
            <span className="text-neutral-400">container:</span> {f.container ?? "-"}
          </div>
          <div>
            <span className="text-neutral-400">video:</span> {f.videoCodec ?? "-"}
          </div>
          <div>
            <span className="text-neutral-400">audio:</span> {f.audioCodec ?? "-"}
          </div>
          <div>
            <span className="text-neutral-400">checked:</span> {formatWhen(f.checkedAt)}
          </div>
        </dl>

        <div className="mt-3">
          <div className="text-xs text-neutral-400">path</div>
          <p className="break-all font-mono text-xs text-neutral-600">{f.path}</p>
        </div>

        {f.errorDetail && (
          <div className="mt-3">
            <div className="text-xs text-neutral-400">ffmpeg findings</div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-red-700">
              {f.errorDetail}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
