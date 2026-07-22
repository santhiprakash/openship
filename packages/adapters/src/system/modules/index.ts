/**
 * Native-module versioning + migration framework (adapter side).
 *
 * Trust chain: catalog-source resolves a signed catalog (remote pinned ref or
 * embedded fallback) → verify.ts gates signature + asset hashes → reconcile.ts
 * applies pending, tiered, run-once migrations to a server and records the
 * result in the on-box manifest. See ./README-style docs in each file.
 */

export * from "./types";
export * from "./verify";
export * from "./on-box-manifest";
export * from "./catalog-source";
export * from "./reconcile";
