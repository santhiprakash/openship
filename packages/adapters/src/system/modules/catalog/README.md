# Bundled module catalog (offline fallback)

Each subdirectory is one native module and mirrors the remote GitHub catalog:

```
<module>/
  catalog.json        # the signed manifest (see modules/types.ts → ModuleCatalog)
  catalog.json.sig    # detached ed25519 signature over catalog.json bytes
  assets/<version>/…  # migration assets (Lua files, .sh scripts) referenced by steps
```

This tree is the **offline fallback**: `scripts/embed-catalog.ts` base64-embeds it
into `catalog-embedded.ts` so an air-gapped instance can still migrate. It is
verified at load time exactly like the remote catalog (`catalog-source.ts`) — the
signature is embedded too, so there is **no unsigned execution path**.

`catalog.json` is signed at release time with the Openship offline ed25519 key
(CI secret); the public half is baked into `verify.ts` (`CATALOG_PUBKEYS`). Until
that key exists the `.sig` is empty and the framework is inert in production
(fail-closed) — dev uses `OPENSHIP_MODULE_CATALOG_INSECURE=1`.

After editing anything here, run `bun run embed:catalog` (in `packages/adapters`).
