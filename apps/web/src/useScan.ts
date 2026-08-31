import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { ScanRun, ScanScope } from "./types";

export interface ScanSnapshot {
  run: ScanRun | null;
  active: boolean;
}

/**
 * Start a scan with instant feedback: the UI flips to a "starting" run
 * optimistically before the request goes out, so buttons and the header bar
 * react the moment they are clicked instead of after the server round-trip.
 */
export function useStartScan(onError?: (err: Error) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["startScan"],
    mutationFn: (v: { scope: ScanScope; sourceId?: number; sourceName?: string }) =>
      api.startScan(v.scope, v.sourceId),
    onMutate: async (v) => {
      await queryClient.cancelQueries({ queryKey: ["scan"] });
      const prev = queryClient.getQueryData<ScanSnapshot>(["scan"]);
      queryClient.setQueryData<ScanSnapshot>(["scan"], {
        active: true,
        run: {
          id: 0, // placeholder until the server returns the real run
          scope: v.scope,
          sourceId: v.sourceId ?? null,
          sourceName: v.sourceName ?? null,
          state: "starting",
          total: 0,
          done: 0,
          issues: 0,
          startedAt: new Date().toISOString(),
          finishedAt: null
        }
      });
      return { prev };
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData<ScanSnapshot>(["scan"], ctx.prev);
      onError?.(err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["scan"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
    }
  });
}

/**
 * Cancel the running scan with instant feedback: the run flips to
 * "cancelling" optimistically and every cancel button disables right away,
 * while the server kills in-flight checks and settles the run.
 */
export function useCancelScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["cancelScan"],
    mutationFn: api.cancelScan,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["scan"] });
      const prev = queryClient.getQueryData<ScanSnapshot>(["scan"]);
      queryClient.setQueryData<ScanSnapshot>(["scan"], (old) =>
        old && old.run ? { ...old, run: { ...old.run, state: "cancelling" } } : old
      );
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData<ScanSnapshot>(["scan"], ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["scan"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    }
  });
}

/**
 * True while a start/cancel mutation is in flight: every observer of the
 * ["scan"] query must pause polling, or a mid-flight refetch overwrites the
 * optimistic placeholder and the header bar flickers.
 */
export function useScanPollingGate(): boolean {
  const starting = useMutationState({ filters: { mutationKey: ["startScan"], status: "pending" } });
  const cancelling = useMutationState({ filters: { mutationKey: ["cancelScan"], status: "pending" } });
  return starting.length > 0 || cancelling.length > 0;
}
