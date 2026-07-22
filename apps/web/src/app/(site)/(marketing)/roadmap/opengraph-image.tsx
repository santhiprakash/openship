import { renderOgImage, OG_SIZE } from "@/lib/og-image";

export const runtime = "edge";
export const alt = "Openship Roadmap - where the open-source deployment platform is going";
export const size = OG_SIZE;
export const contentType = "image/png";

// Violet accent for the "future / roadmap" feel — same clean openship layout,
// distinct tint from the home (green) and download (seafoam) cards.
const VIOLET = { glow: "139,92,246", solid: "#8B5CF6", soft: "#C4B5FD" };

export default function OgImage() {
  return renderOgImage({
    eyebrow: "Roadmap",
    title: "Where Openship is going.",
    subtitle:
      "Clustering & load balancing, webhook-triggered jobs, a durable queue, a managed WAF, a self-hosted CDN, GitLab & Cloudflare, and a mobile app - built in the open.",
    accent: VIOLET,
  });
}
