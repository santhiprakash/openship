import type { Metadata } from "next";
import Link from "next/link";
import {
  Boxes, Scale, Webhook, Layers, ShieldAlert, Globe, Gitlab, Cloud, Smartphone,
  Container, Palette, Braces, CloudCog, Cloudy, Send,
  type LucideIcon,
} from "lucide-react";
import { Navbar, Footer } from "@/components/landing";
import "./roadmap.css";

const PAGE_TITLE = "Roadmap";
const PAGE_DESCRIPTION =
  "Where Openship is going — clustering and load balancing with a one-click UI, webhook-triggered jobs, a durable queue, a managed WAF, a self-hosted CDN, GitLab and Cloudflare, and a mobile app. Built in the open.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/roadmap" },
  openGraph: { title: `${PAGE_TITLE} — Openship`, description: PAGE_DESCRIPTION, url: "/roadmap", type: "website" },
  twitter: { card: "summary_large_image", title: `${PAGE_TITLE} — Openship`, description: PAGE_DESCRIPTION },
};

type Status = "progress" | "next" | "planned" | "exploring";
const STATUS: Record<Status, string> = {
  progress: "In progress",
  next: "Next up",
  planned: "Planned",
  exploring: "Exploring",
};

type Item = { icon: LucideIcon; title: string; desc: string; status: Status };
type Phase = { n: string; name: string; blurb: string; items: Item[]; flagship?: boolean; pitch?: string };

const PHASES: Phase[] = [
  {
    n: "01",
    name: "Scale out",
    blurb: "one deploy target, many machines.",
    items: [
      {
        icon: Boxes,
        title: "Clustering & multi-node",
        status: "progress",
        desc: "Group your servers into a cluster and ship to it as one. Add a node from the dashboard and Openship spreads containers across the fleet, health-checks them, and reschedules failures automatically — no control plane to babysit, no YAML to hand-write.",
      },
      {
        icon: Container,
        title: "Docker Swarm",
        status: "planned",
        desc: "Prefer Swarm? Point Openship at a Swarm cluster and deploy services, scale replicas, and roll updates across the swarm from the same dashboard — your orchestrator of choice, our interface.",
      },
      {
        icon: Scale,
        title: "Load balancing",
        status: "progress",
        desc: "Traffic distributed across healthy nodes out of the box, with a slider for weights and automatic connection draining on every deploy. Zero-downtime rollouts become the default, not a weekend project.",
      },
    ],
  },
  {
    n: "02",
    name: "Automate",
    blurb: "jobs that react, at any scale.",
    items: [
      {
        icon: Webhook,
        title: "Event & webhook triggers",
        status: "next",
        desc: "Fire a job from an inbound webhook or a platform event — a git push, a finished deploy, a failed health check. Chain jobs into pipelines that run themselves, with the trigger you want and the guardrails you set.",
      },
      {
        icon: Layers,
        title: "Queue & advanced runners",
        status: "next",
        desc: "A durable queue behind every job: concurrency limits, backoff, distributed workers, and crash-safe re-drive so an interrupted run never disappears. Same jobs you already write — production-grade underneath.",
      },
    ],
  },
  {
    n: "03",
    name: "Route & protect",
    blurb: "your edge, your rules.",
    items: [
      {
        icon: ShieldAlert,
        title: "Advanced route rules & WAF",
        status: "planned",
        desc: "Compose per-route rules — rate limits, geo and user-agent filters, bans, hotlink protection — into a managed web-application firewall you edit from the dashboard and apply live, with no reloads and no config files.",
      },
      {
        icon: Globe,
        title: "Self-hosted CDN",
        status: "planned",
        desc: "Once the cluster is in place, turn it into your own CDN: cache and serve static assets from every node, close to your users. No third party, no per-gigabyte bill — just your fleet, doing more.",
      },
    ],
  },
  {
    n: "04",
    name: "Make it yours",
    blurb: "your brand, your look.",
    items: [
      {
        icon: Palette,
        title: "White-label & branding",
        status: "planned",
        desc: "Put your name on it. Swap the logo, colors, product name, and login screen so the dashboard your team — or your clients — see is unmistakably yours. Built for agencies and resellers.",
      },
      {
        icon: Braces,
        title: "Custom CSS",
        status: "planned",
        desc: "Drop in your own CSS to restyle anything, from a single accent to a full reskin. Pairs with white-label so the whole surface can match your brand down to the pixel.",
      },
    ],
  },
  {
    n: "05",
    name: "Command the cloud",
    blurb: "AWS & Azure, finally pleasant.",
    flagship: true,
    pitch: "AWS and Azure are extraordinarily powerful — and extraordinarily complex. Hundreds of services, a maze of consoles, and a bill you need a degree to read. If you don't want all that — if you just need to see what's running, spin something up, and get on with your day — Openship becomes a clean, opinionated layer over both: the 20% you actually use, without the 80% you don't. Connect your account and manage it from the same place you deploy.",
    items: [
      {
        icon: CloudCog,
        title: "AWS console & control",
        status: "exploring",
        desc: "Connect your AWS account and run it from Openship — EC2, S3, RDS, IAM and more — through an interface that's actually fast and clean. A better console for the services you touch every day, right next to your deploys.",
      },
      {
        icon: Cloudy,
        title: "Azure console & control",
        status: "exploring",
        desc: "The same for Azure: connect a subscription and manage VMs, storage, databases, and networking from one calm surface — no more hunting through the portal to get one thing done.",
      },
    ],
  },
  {
    n: "06",
    name: "Integrate",
    blurb: "connect the rest of your stack.",
    items: [
      {
        icon: Gitlab,
        title: "GitLab integration",
        status: "planned",
        desc: "First-class GitLab alongside GitHub — repositories, branches, merge-request preview environments, and push-to-deploy, wired exactly the same way you already know.",
      },
      {
        icon: Cloud,
        title: "Cloudflare integration",
        status: "planned",
        desc: "Manage Cloudflare DNS, proxying, and origin certificates straight from Openship, so your domains and edge stay in sync with every deploy — no tab-hopping to keep records straight.",
      },
      {
        icon: Send,
        title: "Amazon SES mail",
        status: "planned",
        desc: "Beyond self-hosted mail: connect Amazon SES and manage senders, domains, and deliverability from Openship — pick the mail engine that fits the job, hosted or your own.",
      },
    ],
  },
];

const LATER: Item = {
  icon: Smartphone,
  title: "Mobile app",
  status: "exploring",
  desc: "Control your fleet from your pocket — deploys, live logs, and alerts pushed to your phone the moment something happens. End-to-end connected to your own self-hosted instance, with no cloud middleman in between.",
};

function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`rm-status ${status === "progress" ? "rm-status--active" : ""}`}>
      {STATUS[status]}
    </span>
  );
}

function MilestoneCard({ item, accent }: { item: Item; accent?: boolean }) {
  const Icon = item.icon;
  return (
    <div
      className={`rm-card rounded-2xl p-7 ${accent ? "rm-card--accent" : ""}`}
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-bd)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-xl"
          style={
            accent
              ? { background: "rgba(139,124,246,.12)", border: "1px solid rgba(167,139,250,.3)" }
              : { background: "var(--th-sf-04)", border: "1px solid var(--th-on-06)" }
          }
        >
          <Icon className="size-5" strokeWidth={1.6} style={{ color: accent ? "#c4b5fd" : "var(--th-text-heading)" }} />
        </div>
        <StatusPill status={item.status} />
      </div>
      <h3 className="mt-5 text-[18px] font-medium tracking-[-0.01em]" style={{ color: "var(--th-text-heading)" }}>
        {item.title}
      </h3>
      <p className="mt-2 text-[14.5px] leading-[1.65]" style={{ color: "var(--th-text-body)" }}>
        {item.desc}
      </p>
    </div>
  );
}

export default function RoadmapPage() {
  return (
    <>
      <Navbar />

      {/* ── HERO ─────────────────────────────────────────────── */}
      <section className="rm-hero hero-section relative flex min-h-[78dvh] flex-col items-center justify-center overflow-hidden">
        <div className="hero-grain absolute inset-0" aria-hidden="true" />
        <div className="hero-grid absolute inset-0" aria-hidden="true" />
        <div className="hero-aurora" aria-hidden="true">
          <div className="hero-aurora-core" />
          <div className="hero-aurora-wing hero-aurora-wing--left" />
          <div className="hero-aurora-wing hero-aurora-wing--right" />
        </div>

        <div className="relative z-20 mx-auto w-full max-w-[820px] px-6 text-center">
          <p className="animate-fade-in-up text-[12px] font-semibold uppercase tracking-[0.16em] th-text-muted">
            Roadmap
          </p>
          <h1 className="animate-fade-in-up animate-delay-100 mt-5">
            <span className="block text-[clamp(2.5rem,5.5vw,4.25rem)] font-medium leading-[1.08] tracking-[-0.02em] th-text-heading">
              Where Openship is going.
            </span>
            <span className="hero-headline-second block text-[clamp(2.5rem,5.5vw,4.25rem)] font-light italic leading-[1.08] tracking-[-0.015em]">
              Built in the open.
            </span>
          </h1>
          <p className="animate-fade-in-up animate-delay-200 mx-auto mt-6 max-w-[560px] text-[16px] leading-[1.65] th-text-body">
            The next chapters — clustering you turn on with a click, jobs that trigger themselves,
            your own edge and CDN, and the integrations you asked for. Shaped in public, shipped as
            open source.
          </p>

          {/* Legend */}
          <div className="animate-fade-in-up animate-delay-300 mt-9 flex flex-wrap items-center justify-center gap-2.5">
            <StatusPill status="progress" />
            <StatusPill status="next" />
            <StatusPill status="planned" />
            <StatusPill status="exploring" />
          </div>
        </div>

        <div className="hero-edge-fade-top absolute top-0 left-0 right-0 h-20" aria-hidden="true" />
        <div className="hero-edge-fade-bottom absolute bottom-0 left-0 right-0 h-40" aria-hidden="true" />
      </section>

      <main className="relative">
        {/* ── PHASES ─────────────────────────────────────────── */}
        {PHASES.map((phase, i) => (
          <section key={phase.n} className="mx-auto max-w-5xl px-6">
            {i === 0 ? <div className="pt-20 sm:pt-24" /> : <div className="rm-spine" />}
            <div className="pb-20 pt-6 sm:pb-24">
              <div className="mb-9">
                <div className="flex items-center gap-3">
                  <p className="font-mono text-[13px] tracking-[0.08em]" style={{ color: "var(--th-text-muted)" }}>
                    PHASE · {phase.n}
                  </p>
                  {phase.flagship && <span className="rm-flagship">★ Flagship</span>}
                </div>
                <h2
                  className="mt-2.5 text-[clamp(1.75rem,3.6vw,2.5rem)] font-medium leading-[1.1] tracking-[-0.025em]"
                  style={{ color: "var(--th-text-heading)" }}
                >
                  {phase.name}{" "}
                  <span className="font-light italic" style={{ color: "var(--th-on-40)" }}>
                    — {phase.blurb}
                  </span>
                </h2>
              </div>
              {phase.pitch && (
                <div className="rm-pitch mb-4">
                  <p>{phase.pitch}</p>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                {phase.items.map((item) => (
                  <MilestoneCard key={item.title} item={item} accent={phase.flagship} />
                ))}
              </div>
            </div>
          </section>
        ))}

        {/* ── LATER ──────────────────────────────────────────── */}
        <section className="mx-auto max-w-5xl px-6">
          <div className="rm-spine" />
          <div className="pb-24 pt-6">
            <div className="mb-9">
              <p className="font-mono text-[13px] tracking-[0.08em]" style={{ color: "var(--th-text-muted)" }}>
                LATER
              </p>
              <h2
                className="mt-2.5 text-[clamp(1.75rem,3.6vw,2.5rem)] font-medium leading-[1.1] tracking-[-0.025em]"
                style={{ color: "var(--th-text-heading)" }}
              >
                Beyond the browser{" "}
                <span className="font-light italic" style={{ color: "var(--th-on-40)" }}>
                  — in your pocket.
                </span>
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <MilestoneCard item={LATER} />
            </div>
          </div>
        </section>

        {/* ── CTA ────────────────────────────────────────────── */}
        <div className="section-divider mx-auto max-w-5xl" />
        <section className="mx-auto max-w-5xl px-6 pb-32 pt-24 sm:pb-40">
          <div className="mx-auto max-w-2xl text-center">
            <h2
              className="text-[clamp(2rem,4vw,2.75rem)] font-medium leading-[1.08] tracking-[-0.025em]"
              style={{ color: "var(--th-text-heading)" }}
            >
              Shape it with us.
            </h2>
            <p className="mx-auto mt-5 max-w-md text-[16px] leading-[1.6]" style={{ color: "var(--th-text-body)" }}>
              Everything here is built in the open. Open an issue, upvote what matters to you, or send
              a pull request — the roadmap follows the community.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
              <a
                href="https://github.com/oblien/openship"
                target="_blank"
                rel="noopener noreferrer"
                className="th-btn group rounded-full px-7 py-3 text-[15px] font-medium"
              >
                <svg className="-ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                Follow on GitHub
              </a>
              <Link href="/docs" className="th-btn-ghost group rounded-full px-7 py-3 text-[15px] font-medium">
                Read the docs
                <svg className="ml-1.5 -mr-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
