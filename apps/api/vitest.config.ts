import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Resolve the app's own `@/*` → `src/*` alias (from tsconfig) so tests can
// import modules whose transitive imports use it (e.g. lib/ssh-manager →
// @/lib/system-debug). Defaults are otherwise unchanged.
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
