#!/bin/sh
# Turbopack (next dev) caches its Tailwind content-scan by content hash and can
# miss git's bulk worktree writes (merge/pull/rebase/stash-pop). When that
# happens the dashboard keeps serving stale CSS — e.g. theme utilities silently
# stop applying — until the file is re-saved or the server restarts. It's a
# SILENT regression, so nudge whenever git rewrote files under a live dev server.
for port in 3001 3002 3000; do
  if lsof -ti "tcp:$port" >/dev/null 2>&1; then
    printf '\n\033[1;33m⚠  Dev server on :%s — git just changed files.\033[0m\n' "$port"
    printf '   Turbopack may now serve stale Tailwind/CSS. Restart it, or run '
    printf '\033[36mbun run --cwd apps/dashboard dev:fresh\033[0m.\n\n'
    break
  fi
done
exit 0
