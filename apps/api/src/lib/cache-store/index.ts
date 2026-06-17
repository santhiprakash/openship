/**
 * CacheStore factory + module-scoped Redis connection.
 *
 * Mirrors the job-runner pattern: probe Redis once, share the
 * decision + connection across all callers in this process.
 *
 *   await createCacheStore<string>("gh-tokens", { maxSize: 5000 })
 *
 * Returns a Redis-backed store when REDIS_URL is reachable; a
 * MemoryCacheStore otherwise. Self-hosted PGlite installs never run
 * Redis and always get the memory backend — no behavioral change vs
 * the legacy TtlCache they had before.
 *
 * Override with `OPENSHIP_CACHE_STORE=memory` or `=redis` to force a
 * backend (handy for tests, and for production deployments that want
 * to opt out of Redis even when REDIS_URL is set).
 */

import IORedis from "ioredis";
import { env } from "../../config/env";
import { MemoryCacheStore } from "./memory";
import { RedisCacheStore } from "./redis";
import type { CacheStore, CacheStoreOptions } from "./types";

export type { CacheStore, CacheStoreOptions } from "./types";

type Backend = "redis" | "memory";

let backendDecision: Backend | null = null;
let resolvingPromise: Promise<Backend> | null = null;
let sharedRedis: IORedis | null = null;
const trackedStores = new Set<CacheStore<unknown>>();

async function isRedisReachable(timeoutMs = 2000): Promise<boolean> {
  const probe = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    connectTimeout: timeoutMs,
  });
  try {
    await Promise.race([
      probe.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe.disconnect();
    } catch {
      // best-effort
    }
  }
}

async function pickBackend(): Promise<Backend> {
  const override = (process.env.OPENSHIP_CACHE_STORE ?? "").toLowerCase().trim();
  if (override === "memory") return "memory";
  if (override === "redis") return "redis";
  return (await isRedisReachable()) ? "redis" : "memory";
}

async function resolveBackend(): Promise<Backend> {
  if (backendDecision) return backendDecision;
  if (resolvingPromise) return resolvingPromise;
  resolvingPromise = (async () => {
    const choice = await pickBackend();
    backendDecision = choice;
    resolvingPromise = null;
    return choice;
  })();
  return resolvingPromise;
}

function getSharedRedis(): IORedis {
  if (sharedRedis) return sharedRedis;
  sharedRedis = new IORedis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  sharedRedis.on("error", (err) => {
    console.warn("[cache-store:redis] connection error:", err.message);
  });
  return sharedRedis;
}

/**
 * Create a namespaced CacheStore. `namespace` MUST be unique per
 * logical cache (e.g. `"gh-tokens"`, `"oauth-bridges"`); two callers
 * with the same namespace share keyspace on Redis and share a
 * TtlCache instance on memory mode.
 *
 * Note that on memory mode, each call returns a NEW MemoryCacheStore.
 * That's fine because each consumer module owns its own cache anyway
 * (the legacy TtlCache behaviour). Cross-namespace isolation is the
 * concern that matters; Redis enforces it via prefix, memory enforces
 * it by simply not sharing the Map.
 */
export async function createCacheStore<T>(
  namespace: string,
  opts: CacheStoreOptions = {},
): Promise<CacheStore<T>> {
  if (!namespace || namespace.includes(" ")) {
    throw new Error(`createCacheStore: invalid namespace "${namespace}"`);
  }
  const backend = await resolveBackend();
  const store: CacheStore<T> =
    backend === "redis"
      ? new RedisCacheStore<T>(getSharedRedis(), namespace)
      : new MemoryCacheStore<T>(opts);
  trackedStores.add(store as CacheStore<unknown>);
  return store;
}

/** Active backend choice — null if no store has been created yet. */
export function describeCacheStore(): Backend | null {
  return backendDecision;
}

/** Graceful shutdown — disposes every tracked store and closes the
 *  shared Redis connection. Idempotent. */
export async function shutdownCacheStores(): Promise<void> {
  for (const store of trackedStores) {
    try {
      await store.dispose();
    } catch {
      // best-effort
    }
  }
  trackedStores.clear();
  if (sharedRedis) {
    try {
      sharedRedis.disconnect();
    } catch {
      // best-effort
    }
    sharedRedis = null;
  }
  backendDecision = null;
}
