#!/bin/sh
# OpenResty module migration 1.1.0 — resize the rate-limit counter shared dict
# from 16m to 32m. Demonstrates a MUTATING migration (edits an existing
# directive) that the append-only `grep || sed-append` convergence cannot do.
#
# Idempotent (no-op if already 32m or absent), config-test-gated, and reverts on
# a failed test so a bad edit never takes the edge down. Distro-agnostic: it
# locates nginx.conf across the common OpenResty layouts at runtime.
set -eu

BIN="$(command -v openresty || echo /usr/local/openresty/bin/openresty)"

CONF=""
for c in \
  /usr/local/openresty/nginx/conf/nginx.conf \
  /etc/openresty/nginx.conf \
  /etc/nginx/nginx.conf; do
  if [ -f "$c" ]; then CONF="$c"; break; fi
done
if [ -z "$CONF" ]; then
  echo "resize-rl-counters: nginx.conf not found" >&2
  exit 1
fi

if grep -q 'lua_shared_dict rl_counters 16m' "$CONF"; then
  cp "$CONF" "$CONF.opsh-bak"
  sed -i 's/lua_shared_dict rl_counters 16m/lua_shared_dict rl_counters 32m/' "$CONF"
  if "$BIN" -t 2>&1; then
    "$BIN" -s reload 2>&1 || true
    rm -f "$CONF.opsh-bak"
    echo "resize-rl-counters: rl_counters 16m -> 32m"
  else
    mv "$CONF.opsh-bak" "$CONF"
    echo "resize-rl-counters: config test failed, reverted" >&2
    exit 1
  fi
else
  echo "resize-rl-counters: already 32m or dict absent, nothing to do"
fi
