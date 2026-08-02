# Instructions for the App Store reviewer

MerchGrid: Catalog Audit is a **read-only** app — it never creates,
edits, or deletes any store data. It requests only `read_products` and
`read_inventory` scopes.

## How to test

1. Install the app on a test store.
2. On the first screen, click "Run catalog audit." No further setup is
   required.
3. The scan runs in the background (typically under a minute for a small
   catalog) and the screen auto-updates to show progress, then results.
4. If your test store's products have no cost data set, most findings
   will appear under "Could not evaluate" (this is expected and correct
   — see the app's own explanation text on that category). To see the
   full range of findings (below-cost pricing, duplicate SKUs, invalid
   sale prices, etc.), add cost data to a couple of products, or set one
   product's price below its cost, before scanning.
5. Every finding links directly to the affected product in your store
   admin ("Open in Shopify").
6. Findings can be exported as CSV from the results screen.
7. The margin threshold used for below-margin findings is adjustable
   under Settings.

## Privacy / data handling

See https://merchgrid-catalog-audit.fly.dev/privacy. No customer, order,
or checkout data is ever accessed.
