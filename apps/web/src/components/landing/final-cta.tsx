import { DarkSection } from "./dark-section";

export function FinalCta() {
  return (
    <section className="fcta-outer">
      <DarkSection>
        <div className="fcta-container">
          <h2 className="fcta-title">
            Ready to ship?
          </h2>
          <p className="fcta-sub">
            Cloud or a server you own.<br />
            No lock-in, no configuration files.
          </p>
          <div className="fcta-row">
            <a href="/login" className="fcta-btn fcta-btn--primary">
              Get started
            </a>
            <a
              href="https://github.com/oblien/openship"
              target="_blank"
              rel="noreferrer"
              className="fcta-btn fcta-btn--ghost"
            >
              View on GitHub
            </a>
          </div>
          <ul className="fcta-trust">
            <li>CLI, web &amp; desktop</li>
            <li>Cloud or self-hosted</li>
            <li>No lock-in</li>
            <li>Open source</li>
          </ul>
        </div>
      </DarkSection>
    </section>
  );
}
