"use client";

/**
 * Full-page fallback shown when the API can't be reached during SSR bootstrap
 * (see getDeploymentInfoOrNull). The deploy/auth mode is known only to the API,
 * so rather than guess it (and render the wrong login flow) or crash into the
 * error boundary, we render this explicit screen. Self-contained inline styles:
 * it renders around/instead of the app providers when the platform is only
 * half-up, so it can't rely on theme/i18n context. Retry re-runs the render,
 * which re-fetches /health/env — if the API is back, the app loads normally.
 */
export function ApiUnavailable() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#ffffff",
        color: "#0f0f0f",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        <div
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            margin: "0 auto 16px",
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.05)",
            border: "1px solid rgba(0,0,0,0.10)",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
            <path d="M12 3v6m0 6v6M5.6 5.6l4.2 4.2m4.4 4.4 4.2 4.2M3 12h6m6 0h6" />
          </svg>
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
          Can&rsquo;t reach the API
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.7, margin: "0 0 20px" }}>
          The dashboard can&rsquo;t load until the Openship API is running. Make
          sure it&rsquo;s up, then retry.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            border: "1px solid rgba(0,0,0,0.16)",
            background: "rgba(0,0,0,0.05)",
            color: "#0f0f0f",
            borderRadius: 999,
            padding: "8px 20px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
