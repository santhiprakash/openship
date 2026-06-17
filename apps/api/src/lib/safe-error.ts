/**
 * Re-export of `safeErrorMessage` from @repo/core.
 *
 * Kept as a thin re-export so the many `import { safeErrorMessage }
 * from "../lib/safe-error"` call sites across the api stay working
 * after the canonical home moved to @repo/core/errors.ts.
 */
export { safeErrorMessage } from "@repo/core";
