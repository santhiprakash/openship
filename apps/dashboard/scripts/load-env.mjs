// Preloads a dotenv file into process.env before Next.js starts.
//
// We can't use `node --env-file=...` to launch Next: Next 16 spawns worker
// child processes and forwards the parent's execArgv via NODE_OPTIONS, and
// Node rejects `--env-file` in NODE_OPTIONS ("--env-file= is not allowed in
// NODE_OPTIONS"). `--import` IS allowed there, so we preload via loadEnvFile
// instead. Real env vars set here take precedence over Next's own `.env`
// loading, matching the old `--env-file` behavior.
import { existsSync } from "node:fs";

const file = process.env.ENV_FILE;
if (file && existsSync(file)) {
  process.loadEnvFile(file);
}
