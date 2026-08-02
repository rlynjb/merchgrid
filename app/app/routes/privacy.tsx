export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem", fontFamily: "sans-serif", lineHeight: 1.6 }}>
      <h1>MerchGrid: Catalog Audit — Privacy Policy</h1>
      <p><em>Last updated: August 2, 2026</em></p>

      <h2>What MerchGrid does</h2>
      <p>
        MerchGrid: Catalog Audit is a read-only Shopify app. It reads your
        product catalog to identify pricing, inventory, and merchandising
        issues, and displays that report to you inside Shopify admin. It
        never modifies your store's products, inventory, or any other data.
      </p>

      <h2>Data we collect and why</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Data</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Why we store it</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Retention</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Shopify access token</td><td>Authenticate API requests to read your catalog. Encrypted at rest.</td><td>Until uninstall</td></tr>
          <tr><td>Shop domain and install status</td><td>Identify your store and its scan configuration</td><td>Until uninstall + GDPR deletion window</td></tr>
          <tr><td>Scan settings (margin threshold, variant limit)</td><td>Apply your chosen thresholds to each scan</td><td>Until uninstall</td></tr>
          <tr><td>Scan results and findings</td><td>Show and export your catalog audit report</td><td>Until uninstall + GDPR deletion window</td></tr>
        </tbody>
      </table>

      <h2>What we do <em>not</em> collect</h2>
      <p>
        We do not request access to, and do not store, your customers,
        orders, checkout data, or any personally identifiable information
        about your shoppers. Our app requests only read-only product and
        inventory access.
      </p>

      <h2>Data deletion</h2>
      <p>
        When you uninstall MerchGrid, your access token is deactivated
        immediately. In compliance with Shopify's mandatory data-protection
        requirements, we permanently delete your shop's stored data
        (settings, scans, findings) when Shopify sends the shop-redact
        request, typically within 48 hours of uninstall. You may also
        request deletion sooner by contacting us (see Support below).
      </p>

      <h2>Security</h2>
      <p>
        Your Shopify access token is encrypted at rest (AES-256-GCM). All
        traffic to and from the app is encrypted in transit (TLS). We
        request only the minimum Shopify API scopes required to read your
        product catalog — no write access of any kind.
      </p>

      <h2>Third parties</h2>
      <p>We do not sell or share your data with third parties.</p>

      <h2>Contact</h2>
      <p>Questions about this policy: buffrstudio@gmail.com</p>
    </main>
  );
}
