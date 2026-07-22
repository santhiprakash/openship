/**
 * Env the jobs E2E harness needs set BEFORE `config/env` (and anything that
 * imports it) is first evaluated. Imported first by `_harness.ts`, which every
 * jobs E2E file imports before touching the real modules.
 *
 *  - INTERNAL_TOKEN     — config/env's boot guard throws without it (non-desktop).
 *  - BETTER_AUTH_SECRET — the encryption key for command-job secrets derives from it.
 *  - OPENSHIP_JOB_RUNNER — force in-process so getJobRunner() never probes Redis.
 * CLOUD_MODE stays unset (false) so the jobs router's `localOnly` doesn't 404.
 */
process.env.INTERNAL_TOKEN ||= "test-internal-token";
process.env.BETTER_AUTH_SECRET ||= "test-better-auth-secret-please-ignore-0123456789";
process.env.OPENSHIP_JOB_RUNNER ||= "in-process";
process.env.DEPLOY_MODE ||= "docker";
