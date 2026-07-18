<h1 align="center">Openship</h1>

<p align="center">
  Source-available, self-hostable deployment platform with built-in CI/CD.<br>
  Push code, ship containers, manage infrastructure — from a desktop app, web dashboard, or CLI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0%20%2B%20Commons%20Clause-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#three-interfaces">Interfaces</a> ·
  <a href="https://openship.io/docs">Docs</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="docs/screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Quick Start

```bash
npm i -g openship
openship init
```

That's it. Or, if you prefer Docker:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

Or download the desktop app from [openship.io](https://openship.io).

---

## What It Does

Point it at a repo. Openship detects your stack, builds it, configures everything, and ships it — zero config files, zero pipelines, zero YAML.

Databases, domains, SSL, CDN, mail, backups — all managed from one place.

Works with **Openship Cloud** (managed) or **any Linux server** you own. Solo devs shipping side projects and teams running production use the same tool.

---

## Features

| | |
|---|---|
| **Built-in CI/CD** | Push-to-deploy, preview environments, staging/prod flows, rollbacks |
| **Any stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos |
| **Full backend** | Postgres, MySQL, MongoDB, Redis, workers, WebSockets, storage |
| **Domains & SSL** | Automatic Let's Encrypt, wildcards, unlimited domains, auto-renewal |
| **CDN** | Edge caching, HTTP/3, Brotli compression, instant purge |
| **Mail server** | Built-in SMTP with DKIM/SPF/DMARC — no Mailgun or SES needed |
| **Backups** | Scheduled, databases + volumes, one-click restore, export anytime |
| **Real-time monitoring** | Live build logs, container metrics, and resource usage streamed to your screen |
| **Scaling** | Auto-scaling on cloud, multi-node ready on self-hosted |
| **Portability** | Standard Docker containers — move between providers freely |
| **Docker Compose** | Deploy existing compose files as-is |

---

## Deploy Anywhere

- **Openship Cloud** — managed, auto-scaling, zero setup
- **Any VPS** — Hetzner, DigitalOcean, Linode, OVH, and the rest
- **Dedicated servers** — bare metal, colo, homelab
- **Multi-server** — spread workloads across machines

Same interface regardless of where you deploy.

---

## Three Interfaces

- **Desktop app** — full GUI, real-time logs, one-click everything.
- **Web dashboard** — the same UI in the browser, built for teams.
- **CLI** — scriptable and CI-friendly.

A **REST API** and **MCP** (AI agent protocol) round it out for automation and tooling integration. Full command and API reference at [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> The docs are still a work in progress — we're actively filling them out. If something's missing or unclear, [contributions](CONTRIBUTING.md) are hugely welcome and help us get there faster.

---

## Status

Production-ready core, actively developed.

**Coming next:** multi-node clusters, load-balancing UI, private networking, advanced monitoring, and visual CI/CD pipelines.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Openship is **source-available** software: [AGPL-3.0 with the Commons Clause](LICENSE).

You may run, modify, and self-host it — including for internal commercial or
company use — under the AGPL-3.0 terms. Offering Openship to third parties as a
hosted, managed, or **SaaS** service is reserved to **Openship and Oblien LLC**;
any other party needs a separate commercial license from Oblien LLC. Because of
the Commons Clause, this is **not** an OSI-approved open-source license.
