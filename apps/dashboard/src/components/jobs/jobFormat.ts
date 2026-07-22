import { CheckCircle2, Loader2, XCircle } from "lucide-react";

/** Shared run formatting/status helpers for the jobs UI (list, detail, logs). */

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function statusTone(status: string): string {
  return status === "success" ? "text-success" : status === "failed" ? "text-danger" : "text-warning";
}

export function statusIcon(status: string) {
  return status === "success" ? CheckCircle2 : status === "failed" ? XCircle : Loader2;
}
