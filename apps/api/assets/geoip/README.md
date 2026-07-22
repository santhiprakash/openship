# Vendored GeoLite2-Country database

`GeoLite2-Country.mmdb` is our own copy of the MaxMind GeoLite2 country
database, used by `apps/api/src/lib/geo-ip.ts` to resolve a server's IP to a
country flag in the Servers list.

**Why it's committed here:** production reads this shipped copy — the running
server never depends on a third-party mirror. It's copied into `dist/assets`
at build (`scripts/copy-assets.mjs`) and resolved relative to the bundle.

**Updating:** run `bun run update:geoip` from the repo root and commit the
result. That script is the only place an upstream mirror is referenced, and it
runs at maintainer/CI time, not on a customer's server. Point it elsewhere with
`GEOIP_UPSTREAM_URL` (e.g. MaxMind directly with a license key).

**Runtime overrides:** `OPENSHIP_GEOIP_DB` (explicit path) and
`OPENSHIP_GEOIP_URL` (download fallback, defaults to our repo).

Data © MaxMind, GeoLite2 — see https://www.maxmind.com. Attribution required.
