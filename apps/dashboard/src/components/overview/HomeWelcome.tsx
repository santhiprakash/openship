"use client";

import React from "react";
import Link from "next/link";
import { Plus, Github, GitBranch, Zap, ShieldCheck } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

const FEATURES = [
  { icon: Zap, label: "Zero config", sub: "Push to deploy" },
  { icon: GitBranch, label: "Any Git repo", sub: "GitHub & more" },
  { icon: ShieldCheck, label: "Auto HTTPS", sub: "SSL out of the box" },
] as const;

/**
 * First-run welcome shown on the home page when the user has no projects.
 * Same visual family as the projects EmptyState (themed SVG, dual CTAs,
 * feature row) but a distinct "launch" motif so the two pages don't feel
 * identical. Neutral --th-* vars only; the primary accent lives on the CTA.
 */
const HomeWelcome: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="px-6 py-6 sm:py-10 sm:pb-12">
      {/* Illustration */}
      <div className="relative mx-auto w-60 h-40 mb-2">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 240 170" fill="none">
          {/* dashed orbit */}
          <circle cx="120" cy="86" r="64" stroke="var(--th-bd-subtle)" strokeWidth="1.5" strokeDasharray="4 7" />
          {/* base shadow */}
          <ellipse cx="116" cy="150" rx="56" ry="7" fill="var(--th-on-04)" />

          {/* project card stack */}
          <rect x="74" y="64" width="98" height="68" rx="13" fill="var(--th-sf-03)" />
          <rect x="66" y="56" width="98" height="68" rx="13" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
          {/* header bar + traffic lights */}
          <rect x="66" y="56" width="98" height="22" rx="13" fill="var(--th-sf-05)" />
          <circle cx="80" cy="67" r="3.5" fill="#ef4444" fillOpacity="0.6" />
          <circle cx="91" cy="67" r="3.5" fill="#eab308" fillOpacity="0.6" />
          <circle cx="102" cy="67" r="3.5" fill="#22c55e" fillOpacity="0.6" />
          {/* content lines */}
          <rect x="80" y="90" width="42" height="5" rx="2.5" fill="var(--th-on-12)" />
          <rect x="80" y="101" width="64" height="4" rx="2" fill="var(--th-on-08)" />
          <rect x="80" y="110" width="48" height="4" rx="2" fill="var(--th-on-08)" />

          {/* dashed launch trail from card corner up to the badge */}
          <path d="M158 64 Q 172 54 174 48" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" />

          {/* launch badge — upward "ship it" arrow */}
          <circle cx="176" cy="44" r="21" fill="var(--th-card-bg)" />
          <circle cx="176" cy="44" r="17" fill="var(--th-on-05)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M176 53V35M169 42l7-8 7 8" stroke="var(--th-on-40)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* sparkles + decorative dots */}
          <path d="M40 64l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M214 118l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-12)" />
          <circle cx="34" cy="108" r="5" fill="var(--th-on-06)" />
          <circle cx="206" cy="58" r="3" fill="var(--th-on-12)" />
          <circle cx="46" cy="38" r="3" fill="var(--th-on-10)" />
          <circle cx="200" cy="150" r="4" fill="var(--th-on-08)" />
        </svg>
      </div>

      {/* Copy */}
      <div className="text-center">
        <h3 className="text-xl font-medium text-foreground/85 mb-1.5" style={{ letterSpacing: "-0.2px" }}>
          {t.overview.welcome.title}
        </h3>
        <p className="text-sm text-muted-foreground/80 max-w-sm mx-auto mb-6 leading-relaxed">
          {t.overview.welcome.subtitle}
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/library"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
          >
            <Plus className="size-4" />
            {t.overview.welcome.createProject}
          </Link>
          <Link
            href="/library"
            className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
          >
            <Github className="size-4" />
            {t.overview.welcome.importGithub}
          </Link>
        </div>
      </div>

      {/* Feature row */}
      {/* <div className="grid grid-cols-3 gap-3 max-w-md mx-auto mt-9">
        {FEATURES.map(({ icon: Icon, label, sub }) => (
          <div key={label} className="bg-card border border-border/50 rounded-xl p-3.5 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-2.5">
              <Icon className="size-4 text-muted-foreground" />
            </div>
            <p className="text-[13px] font-medium text-foreground leading-tight">{label}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
          </div>
        ))}
      </div> */}

      <p className="text-center text-xs text-muted-foreground/60 mt-7">
        {t.overview.welcome.tipPrefix}{" "}
        <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">⌘ K</kbd>{" "}
        {t.overview.welcome.tipSuffix}
      </p>
    </div>
  );
};

export default HomeWelcome;
