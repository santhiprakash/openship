import React from "react";

/**
 * The projects empty-state illustration (card stack + folder + dashed plus),
 * extracted so both the full page empty state and the per-target empty state
 * share one source. Theme-driven via --th-* tokens.
 */
export function ProjectIllustration({ className }: { className?: string }) {
  return (
    <div className={className ?? "relative mx-auto h-44 w-64"}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 260 180" fill="none">
        {/* Background card stack effect */}
        <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
        <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
        <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

        {/* Card header bar */}
        <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
        <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
        <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
        <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />

        {/* Content placeholder lines */}
        <rect x="70" y="65" width="50" height="5" rx="2.5" fill="var(--th-on-12)" />
        <rect x="70" y="76" width="85" height="4" rx="2" fill="var(--th-on-08)" />
        <rect x="70" y="85" width="65" height="4" rx="2" fill="var(--th-on-08)" />

        {/* Folder/project icon */}
        <rect x="70" y="100" width="28" height="22" rx="5" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="1" />
        <path d="M74 105h8l2.5 2.5h9.5v11H74V105z" fill="var(--th-on-10)" />

        {/* Dashed plus button */}
        <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
        <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
        <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />

        {/* Decorative elements */}
        <circle cx="30" cy="60" r="4" fill="var(--th-on-10)" />
        <circle cx="40" cy="140" r="6" fill="var(--th-on-08)" />
        <circle cx="230" cy="40" r="3" fill="var(--th-on-12)" />
        <circle cx="245" cy="130" r="5" fill="var(--th-on-06)" />
        <path d="M25 100l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
        <path d="M220 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
        <path d="M185 95 Q 192 92 195 90" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
      </svg>
    </div>
  );
}

export default ProjectIllustration;
