export default function Support() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem", fontFamily: "sans-serif", lineHeight: 1.6 }}>
      <h1>MerchGrid: Catalog Audit — Support</h1>

      <p>
        Email <strong>[YOUR SUPPORT EMAIL]</strong> and we'll get back to
        you, typically within [YOUR RESPONSE TIME, e.g. 2 business days].
      </p>

      <h2>Common questions</h2>

      <h3>My scan is stuck or taking a long time</h3>
      <p>
        Scans run in the background and can take a few minutes for larger
        catalogs. If it's been stuck for over 15 minutes, uninstall and
        reinstall the app, or contact support with your shop domain and
        approximately when you started the scan.
      </p>

      <h3>A finding looks wrong or doesn't apply to me</h3>
      <p>
        Warnings in particular may reflect an intentional setup (e.g.
        deliberately reused SKUs for bundles). Findings are review
        recommendations, not guaranteed errors — see the explanation text
        on each finding for why it was flagged.
      </p>

      <h3>I don't see a finding I expected</h3>
      <p>
        Some checks require unit cost data on a variant to run (margin and
        below-cost checks). If cost data is missing, that variant shows up
        under "Could not evaluate" instead.
      </p>

      <h3>My CSV export looks wrong</h3>
      <p>
        Contact support with the scan date and which column looks
        incorrect.
      </p>

      <h3>I have a privacy or data-deletion request</h3>
      <p>
        See our <a href="/privacy">Privacy Policy</a>, or email
        [YOUR SUPPORT EMAIL] directly to request deletion sooner than the
        automatic post-uninstall window.
      </p>
    </main>
  );
}
