# User Override Locks

**Human-in-the-loop guardrails (approval gates / override locks on autonomous action) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where an override lock sits in MerchGrid

┌─ UI layer — app.settings.tsx ────────────────────────────────┐
│  merchant sets minimumMarginPercent (0-90) — a real, tunable    │
│  guardrail, but a THRESHOLD, not a lock on an autonomous action  │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — shopify.app.toml + shopify.server.ts ───────────┐
│  ★ THE REAL LOCK IN THIS REPO: scopes = "read_products,           │
│  read_inventory" — NO write scope requested, at all, anywhere ★    │
│  (shopify.app.toml line 10)                                          │
│                                                                         │
│  a per-CHANGE merchant-approval override lock (spec §25.4) would        │
│  live here in the future MerchGrid: Bulk AI write path — does not        │
│  exist because there is no write path to approve                          │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ───────────────────────────────────────┐
│  read-only findings persisted; never a write BACK to Shopify              │
└───────────────────────────────────────────────────────────────────────┘
```

An override lock is anything that stops an autonomous system — a script, an agent, a model — from taking an action a human hasn't explicitly signed off on. MerchGrid's real story here is unusually clean: instead of building a per-action approval gate to contain an autonomous system that could otherwise write to a merchant's store, it removed the capability to write at all. That's the strongest possible version of this pattern, and it's worth understanding both why that was the right call for this product and what a softer, per-change version of the same idea would need to look like for the AI-assisted product this one is deliberately laying groundwork for.

## Structure pass

**Layers:** the concept sits at the boundary between "a system that decides an action should happen" and "the action actually taking effect" — anywhere that boundary exists, a lock can be inserted (or, as MerchGrid does, the boundary can be made structurally impossible to cross at all).

**Axis: trust — what can the automated side of the system actually do without a human?** Trace it across MerchGrid's real architecture: the UI band, a merchant reads findings and clicks through to Shopify admin themselves — the automated system never acts on their behalf. The service band, the entire scan pipeline only ever *reads* — `readCatalog` in `catalog-reader.server.ts` issues nothing but GraphQL `query` operations, never a `mutation` (the file's own comment, line 39-40: "Read-only: this module must never issue a mutation. Only `query` operations below."). The provider band, Shopify itself enforces this from the outside — the app's registered scopes (`shopify.app.toml` line 10: `scopes = "read_products,read_inventory"`) don't include a single write scope, so even a bug in MerchGrid's own code couldn't issue a mutation Shopify would accept; the platform itself is the backstop.

**Seam:** in a system with an autonomous write capability, the seam is the approval gate — the exact point where a proposed action pauses for a human decision before it takes effect. MerchGrid's seam is different in kind: instead of a gate a proposed write passes through, there's a hard boundary (missing scopes, and a codebase with zero mutation calls) that a write can never reach in the first place. That's a stronger, simpler guarantee than any approval-gate implementation could offer — you can't misconfigure a gate that doesn't need to exist.

## How it works

### Move 1 — the mental model

You've built a form that disables its submit button until a checkbox is ticked, or a CI pipeline that requires a human "approve" click before a deploy proceeds. An override lock, in the AI-agent context, is the same idea applied to a model's proposed action instead of a form submission or a deploy — the system can *propose*, but a human has to explicitly authorize before the proposal becomes a real, effectful action.

```
Pattern — the approval-gate shape (the general case, not MerchGrid's)

  autonomous system proposes an action
        │
        ▼
  ┌──────────────────────┐
  │  APPROVAL GATE          │   holds the action here — nothing
  │  (a human must act)      │   downstream executes until a human
  └──────────┬────────────────┘   explicitly says "go"
             │
       approved? ──no───► action discarded / logged / returned for revision
             │
            yes
             │
             ▼
     action executes for real (a write, an API call with side effects)
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the strongest lock isn't a gate at all, it's removing the capability.** Before reaching for "add an approval step," it's worth asking whether the system needs the capability to act autonomously in the first place. A gate can be misconfigured, bypassed by a bug, or silently widened in scope over time ("just this once, skip the approval for small changes" is how gates erode). A capability that was never granted has none of those failure modes — there's no gate to misconfigure. MerchGrid takes exactly this route: rather than building "the scan pipeline can write to Shopify, gated by an approval step," the app requests no write scopes at all (`shopify.app.toml` line 10), and its own code path contains zero mutation calls (verified directly in `catalog-reader.server.ts`'s only GraphQL queries, lines 41-79 and 87-115 — both explicitly `query`, never `mutation`). Two independent layers enforce the same guarantee: even if a bug in MerchGrid's code somehow attempted a mutation, Shopify's platform-level scope check would reject it, because the OAuth grant this app was installed with never included write access.

**Part 2 — where removing the capability isn't an option, the gate needs a real decision point, not a rubber stamp.** Most systems that DO need to act (a bulk editor, an agent with real tool access) can't just remove the capability — writing is the point. For those, the gate has to be a genuine pause: the proposed action, in full, needs to be visible to the human before approval (not "click OK" with no detail), and the system must not proceed past the gate on any path — timeout, retry, or error included — without that explicit signal.

```
function proposeAndGate(action, humanDecision):
  present(action)                        // full detail, not a summary
  decision = await humanDecision(action)  // BLOCKS here — no default-approve
  if decision == "approved":
    return execute(action)
  else:
    return discard(action)               // no partial execution on ambiguity
```

**Part 3 — severity-based gating narrows how often a human has to look, without weakening the lock.** A pure "every action needs sign-off" gate doesn't scale if the volume of proposed actions is high — reviewers get fatigued and start rubber-stamping, which quietly defeats the gate. A common refinement: classify proposed actions by risk, and only force a human decision on the risky ones, auto-approving (or auto-blocking) the rest. This is exactly the shape MerchGrid's own severity model already uses for a *different* purpose — `FindingSeverity`'s `"CRITICAL" | "WARNING" | "UNAVAILABLE"` (`app/packages/catalog-checks/src/contract.ts` line 3) already separates "needs the merchant's attention regardless" (CRITICAL) from "may be intentional, use judgment" (WARNING) — the same tiering instinct a real approval gate would reuse to decide which proposed changes require a click and which can proceed automatically.

**In this codebase:** the lock that exists today is structural, not a gate — there is nothing to approve because there is nothing that can write. Spec acceptance criteria §21.6 states this as a requirement in its own words: "No Shopify mutation exists in the production application path. No write scopes are requested. A scan never changes product data." `shopify.app.toml` line 10 (`scopes = "read_products,read_inventory"`) and `catalog-reader.server.ts`'s query-only GraphQL calls are the concrete evidence that requirement is actually implemented, not just documented. The merchant-facing control that *does* exist — `ShopSettings.minimumMarginPercent`, set via `app.settings.tsx` and validated by `assertValidMargin` in `app/app/models/settings.server.ts` (lines 8-20, enforcing an integer 0-90) — is worth distinguishing precisely from an override lock: it's a merchant-configurable **threshold** that changes which findings `mg-003` reports, not a gate a proposed action passes through, and it isn't an LLM override at all — no LLM writes to or reads this setting, and no autonomous system's proposed action is being approved or blocked by it.

If MerchGrid built the roadmapped bulk-AI feature, a genuine approval gate would become necessary for the first time, because that product's entire premise is a write path this one deliberately doesn't have. The product spec's own future flow (§25.4) already names the gate explicitly — "Merchant approval" sits between "Critical issues blocked / Warnings require review" and "Shopify write operation":

```
Future flow (roadmap, not built) — the approval gate this app has never needed

  Merchant prompt or CSV
          │
          ▼
  LLM proposes a changeset (new services/ai/ — does not exist)
          │
          ▼
  runChecks(ALL_CHECKS, ctx)  — REAL, existing code, reused as preflight
          │
   CRITICAL → blocked outright, no approval possible
   WARNING  → ★ APPROVAL GATE: merchant must explicitly review ★  ← new, not built
          │
          ▼
  Shopify write operation  ← would require NEW write scopes this app
                              has never requested (shopify.app.toml
                              would need write_products added)
          │
          ▼
  Post-write verification
```

That gate would need real scopes this app doesn't have today (adding `write_products` or similar to `shopify.app.toml`, a change the current product deliberately avoids per §21.6 and §27's "Delay... write access until real merchant demand is demonstrated"), a new UI surface for a merchant to review a proposed diff before approving, and — reusing this file's Move 2 Part 3 insight — probably a severity-based rule reusing `FindingSeverity` so CRITICAL findings against a proposed change are never auto-approvable no matter what, while WARNING-level ones might get a lighter review flow.

### Move 3 — the principle

The strongest override lock is a capability that was never granted — no gate to misconfigure, no bypass path, no rubber-stamp failure mode, because there's nothing on the other side of the boundary to approve. Where a system genuinely needs the capability to act (writing, not just reading), the gate has to block by default, show the human the real proposed action, and ideally tier by risk so reviewer fatigue doesn't quietly erode the guarantee. MerchGrid chose the first option for its entire MVP; its own roadmap names exactly where the second option becomes necessary once the product's job changes from reading to writing.

## Primary diagram

```
Primary diagram — structural lock (real, today) vs approval gate (roadmap)

  MERCHGRID TODAY — structural lock, two independent layers
  ──────────────────────────────────────────────────────────
  code layer:     catalog-reader.server.ts issues ONLY GraphQL `query`
                  operations (lines 41-79, 87-115) — zero mutations exist
  platform layer: shopify.app.toml scopes = "read_products,read_inventory"
                  (line 10) — Shopify itself rejects any write attempt,
                  even a hypothetical one from a future bug

  MERCHGRID: BULK AI (roadmap) — approval gate, not yet built
  ──────────────────────────────────────────────────────────
  LLM proposes changeset → runChecks preflights (reused, real code)
        → CRITICAL: blocked outright, no gate needed, decision is final
        → WARNING:  ★ approval gate — merchant must explicitly review ★
        → approved  → Shopify write (needs NEW scopes, not requested today)
```

## Elaborate

Human-in-the-loop approval gates are the AI-agent-era instance of a much older idea: the two-person rule in banking (no single employee can authorize a large transfer alone), a deploy pipeline requiring a second reviewer's sign-off, or `sudo` prompting for a password before a destructive command runs. What's specific to LLM/agent systems is that the "actor" proposing the action is probabilistic and non-deterministic (`01-what-an-llm-is.md`, `03-sampling-parameters.md`) — the same prompt can propose a different action on a retry, which makes "show the human exactly what's about to happen, not a summary" (Move 2 Part 2) a stricter requirement than it would be for a deterministic script proposing the same action every time. MerchGrid's product spec treats the whole category of "give the app any write capability at all" with real caution — §23.6 names the risk directly ("Merchant expects fixes... Users assume the app repairs findings automatically") and the mitigation is exactly this file's Move 1 instinct: keep repeating "read-only," and only grant write capability once real demand justifies building the review machinery a write path requires.

## Project exercises

### Build a severity-gated approval stub for a fake proposed changeset

- **Exercise ID:** EX-1
- **What to build:** A new `app/app/services/ai/approval-gate.server.ts` exporting `decideGate(findings: CatalogFinding[]): "blocked" | "needs_review" | "auto_approved"`, reusing the real `FindingSeverity` type from `app/packages/catalog-checks/src/contract.ts` — any `CRITICAL` finding forces `"blocked"`, any `WARNING` (with no `CRITICAL` present) forces `"needs_review"`, and an empty or all-`UNAVAILABLE` finding set returns `"auto_approved"`. Feed it fixture `CatalogFinding[]` arrays representing a proposed changeset that has already been run through `runChecks`.
- **Why it earns its place:** It's the smallest possible artifact that proves out the exact reuse this file argues for — the severity model built for read-only auditing becomes the gating logic for a future write path, without inventing a new taxonomy.
- **Files to touch:** New file `app/app/services/ai/approval-gate.server.ts`; new test `app/app/services/ai/approval-gate.test.ts`.
- **Done when:** A test with a mixed CRITICAL+WARNING finding set asserts `"blocked"` wins (CRITICAL always dominates), and a WARNING-only set asserts `"needs_review"`.
- **Estimated effort:** 1 hour.

### Verify the real structural lock by grepping for mutations and write scopes

- **Exercise ID:** EX-2
- **What to build:** Nothing new — a verification pass (documented in a scratch note) confirming there are zero occurrences of `mutation` in any GraphQL query string across the repo, and that `shopify.app.toml`'s `scopes` line contains no `write_` prefix. This is the exercise that turns "the spec says it's read-only" into "I checked, and it's true."
- **Why it earns its place:** This is the single fastest way to be able to defend, under interview pressure, a specific claim ("this app cannot write to Shopify") with evidence instead of trust in the product spec's prose.
- **Files to touch:** No production files — `grep -rn "mutation" app/app/services/ app/packages/` and inspect `shopify.app.toml` line 10.
- **Done when:** You can state the exact grep command and its zero-result output from memory, and quote the exact scopes line.
- **Estimated effort:** 15 minutes.

## Interview defense

**Q: What's the strongest form of an override lock on an autonomous system?**
A: Not granting the capability at all. A gate can be misconfigured, bypassed by a bug, or eroded over time by reviewer fatigue; a capability that was never granted has none of those failure modes. MerchGrid does exactly this — it requests `read_products,read_inventory` scopes only (`shopify.app.toml` line 10), no write scope at all, so even a bug in its own code couldn't produce a mutation Shopify would accept.

```
  approval gate:        proposed action → HUMAN DECIDES → maybe executes
  removed capability:   proposed action → CANNOT execute, no decision needed
```

**Q: Is MerchGrid's `minimumMarginPercent` setting an example of an LLM override lock?**
A: No, and it's worth being precise about why not, since it superficially looks like "a merchant-configurable guardrail." It's a threshold that changes which findings a deterministic check (`mg-003`) reports — validated as an integer 0-90 by `assertValidMargin` in `app/app/models/settings.server.ts`. No LLM reads or writes it, and it doesn't gate an autonomous action; it tunes a comparison. An override lock gates a *proposed action* before it takes effect; this setting changes the *input* to a rule that was always going to run.

**Q: If MerchGrid built the AI-assisted bulk editor, what would the approval gate need that today's app doesn't have?**
A: New Shopify write scopes it deliberately doesn't request today (spec §21.6, §27), a UI surface showing the merchant the actual proposed diff (not a summary) before they approve it, and gating logic that treats any CRITICAL finding from the existing check engine as an automatic block, never something a merchant can override with a click — reusing `FindingSeverity` for that tiering, per spec §25.4's flow, rather than inventing a new risk taxonomy from scratch.

## See also

- `07-heuristic-before-llm.md` — the check engine whose severity model this file reuses as the future gate's risk tiering.
- `08-provider-abstraction.md` — the seam an LLM provider call would sit behind; the approval gate sits downstream of that call's output, not inside it.
- `app/app/services/shopify/catalog-reader.server.ts` — the real, query-only code that is half of today's structural lock.
- `shopify.app.toml` — the real, platform-enforced scopes that are the other half.
