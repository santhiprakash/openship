/**
 * Docker-migration run SSE channel. Mirrors restore.sse.ts.
 */

import type { DockerMigrationRun, DockerMigrationStatus } from "@repo/db";
import { createRunBus } from "../../lib/run-sse";

export type MigrationRunEvent =
  | {
      type: "transition";
      status: DockerMigrationStatus;
      bytesMoved?: number | null;
      deploymentId?: string | null;
    }
  | { type: "snapshot"; run: DockerMigrationRun }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "rolled_back";
      errorMessage?: string | null;
    };

const TERMINAL: ReadonlySet<DockerMigrationStatus> = new Set([
  "succeeded",
  "failed",
  "rolled_back",
]);

export const migrationRunBus = createRunBus<MigrationRunEvent>(
  (e) =>
    e.type === "complete" ||
    (e.type === "transition" && TERMINAL.has(e.status)),
);
