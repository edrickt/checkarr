import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useScanPollingGate } from "./useScan";

/** The one stats query; refetches fast while a scan is running. */
export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: (q) => (q.state.data?.activeScan ? 1500 : 10000)
  });
}

/** The one scan-state query; paused while optimistic mutations are in flight. */
export function useScanState() {
  const paused = useScanPollingGate();
  return useQuery({
    queryKey: ["scan"],
    queryFn: api.currentScan,
    refetchInterval: paused ? false : (q) => (q.state.data?.active ? 1500 : 30000)
  });
}

export function useSources() {
  return useQuery({ queryKey: ["sources"], queryFn: api.sources });
}

export function useSettingsQuery() {
  return useQuery({ queryKey: ["settings"], queryFn: api.settings });
}
