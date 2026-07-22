/**
 * Proxy config import — read an existing reverse proxy's configuration and
 * normalize its sites so a migrate/takeover can re-register them as Openship
 * routes. All parsing is read-only and best-effort (warnings, never throws).
 */

import type { CommandExecutor } from "../../types";
import type { ProxyKind, ProxyScanResult } from "../types";
import { scanNginx } from "./nginx";
import { scanCaddy } from "./caddy";
import { scanApache } from "./apache";

/**
 * Scan a specific proxy's config into normalized sites. Returns an empty result
 * (with a warning) for proxies we can't import (traefik/haproxy are label/route
 * driven — takeover-only for now).
 */
export async function scanImportableSites(
  executor: CommandExecutor,
  proxy: ProxyKind,
): Promise<ProxyScanResult> {
  switch (proxy) {
    case "nginx":
      return scanNginx(executor);
    case "caddy":
      return scanCaddy(executor);
    case "apache":
      return scanApache(executor);
    default:
      return {
        proxy,
        sites: [],
        warnings: [`${proxy}: config import not supported — takeover only`],
      };
  }
}

/** Which recognized proxies can we import config from? */
export function canImportProxy(proxy: ProxyKind | undefined): boolean {
  return proxy === "nginx" || proxy === "caddy" || proxy === "apache";
}

export { scanNginx, scanCaddy, scanApache };
