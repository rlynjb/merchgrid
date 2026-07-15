# Tokenization

**Tokenization (subword segmentation, e.g. BPE) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where tokenization would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx                            │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — app/app/services/scan/ ───────────────────────┐
│  runner.server.ts: reads catalog, normalizes, runs checks       │
│                                                                  │
│         ★ a tokenizer call would live here (a new step) ★       │
│         — does not exist; nothing here turns text into tokens   │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-core, packages/catalog-checks ┐
│  normalizeCatalog() works on STRINGS the whole way through:      │
│  productTitle.trim(), sku.toLowerCase() — never token IDs        │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ───────────────────────────────┐
│  finding.explanation stored as plain text, never as token IDs    │
└───────────────────────────────────────────────────────────────┘
```

`01-what-an-llm-is.md` left "tokens in" as a black box — a sequence of integers goes into the model's forward pass. This file opens that box: how does "Flag active variant at $0.00" turn into a sequence of integers, and why does that step exist at all instead of just feeding in raw characters or whole words?

## Structure pass

**Layers:** the same four MerchGrid bands as always, plus one more granular layer specific to this concept — the **tokenizer boundary** sitting between "text a human wrote" and "the sequence the model actually consumes."

**Axis: state — what shape does the data have at each hop?** Trace it: UI — text in Polaris components (JS strings). Service — text in Prisma rows and TypeScript objects (`explanation: string`, `title: string` in `contract.ts`). Engine — text stays text; `normalizeVariant` in `app/packages/catalog-core/src/normalize.ts` (lines 70-107) does `.trim()`, `.toLowerCase()`-style normalization but never converts anything to a numeric ID. Storage — text stored as SQLite text columns. **The answer to "what shape is the data" never changes across this entire repo: it's a string, top to bottom.** That flat answer is itself informative — it's the seam that tells you no tokenizer boundary exists anywhere in MerchGrid today.

**Seam:** the tokenizer boundary, where it would exist, is a horizontal seam between "prompt-construction code" and "the model provider's API" — the seam flips the axis from "string" to "sequence of integers, in a vocabulary specific to that model family." In MerchGrid, that seam has literally nothing on either side of it yet.

## How it works

### Move 1 — the mental model

You already do a version of this when you write a `key` for a React list — you take something meaningful to a human and canonicalize it into an identifier the machine indexes cheaply. Tokenization does that at the level of language: instead of indexing sentences or words, it indexes **subword chunks**, chosen so a fixed-size vocabulary (tens of thousands of entries) can still represent literally any string, including words the vocabulary never explicitly memorized.

```
Pattern — text collapses into a fixed vocabulary of subword chunks

  "MerchGrid flagged mg-003"
          │
          ▼
  ┌───────────────────────────────────────────┐
  │  greedy longest-match against a fixed      │
  │  vocabulary of ~50k-100k learned chunks     │
  └───────────────────────────────────────────┘
          │
          ▼
  [ "Merch", "Grid", " flagged", " mg", "-", "003" ]
          │
          ▼
  [ 8723, 41902, 6188, 285, 12, 24063 ]   ← token IDs, what the model sees
```

### Move 2 — the step-by-step walkthrough

**Part 1 — why not one token per character, or one token per word?** Character-level tokenization gives you a tiny vocabulary (maybe 256 entries) but makes every sequence enormous — "MerchGrid" becomes 9 tokens before you've said anything, and the model has to learn spelling from scratch. Word-level tokenization gives you short sequences but an unbounded vocabulary — every SKU, every typo, every product name variant needs its own slot, and anything unseen at training time becomes an `<UNK>` token the model can't reason about at all. Subword tokenization (Byte-Pair Encoding and its relatives) is the compromise: common whole words ("the", "price") get single tokens, rare or unseen strings ("MerchGrid", a SKU like "SKU-0042-XL") get split into a handful of smaller pieces that the model *has* seen, so nothing is ever truly out-of-vocabulary.

**Part 2 — how the vocabulary gets built (BPE, at a glance).** This runs once, offline, before any inference ever happens — it's a preprocessing step over a huge text corpus, not something that runs per-request.

```
Pattern — building a BPE vocabulary (offline, once)

  start: every character is its own token
  repeat N times:
    find the MOST FREQUENT adjacent pair of tokens in the corpus
    merge that pair into one new token, add it to the vocabulary
  stop after reaching the target vocabulary size (e.g. 50,000 tokens)
```

Concretely: if "ing" shows up constantly as `i`+`n`+`g` in the training corpus, BPE eventually merges it into a single `ing` token. That's why English words split at oddly satisfying boundaries ("token", "ization" — not "tok", "eniz", "ation") — the merges track real statistical structure in the language, not linguistic rules a human wrote down.

**Part 3 — tokenization is why "count the letters" and "reverse this string" are famous LLM failure modes.** The model never sees individual characters unless a token happens to be exactly one character long. Ask it to reverse "strawberry" and it's reasoning over 2-3 opaque token IDs, not 10 characters — it literally cannot see the letters unless it was trained on enough examples to memorize the answer indirectly. This is the single most useful fact to carry out of this file: everything the model "perceives" about your input is filtered through whatever the tokenizer happened to chunk it into.

**Part 4 — the same text costs different token counts depending on the tokenizer and the language.** Common English words compress well (short token count); rare identifiers, non-English scripts, and dense punctuation compress poorly (more tokens per character). This is the direct link to `06-token-economics.md` — token count, not character count, is what you're billed for and what counts against the context window.

```
Pattern — tokenizers are model-family-specific, not universal

  ┌─ GPT family tokenizer ──────┐   ┌─ a different model family ──┐
  │  "mg-003" → 3-4 tokens        │   │  "mg-003" → different split  │
  └───────────────────────────────┘   └────────────────────────────┘
  Two different providers' tokenizers do NOT agree on token counts
  for the same string — this is a real portability hazard, covered
  in 08-provider-abstraction.md.
```

**In this codebase:** not yet implemented — there is no tokenizer, no vocabulary file, no token-counting utility anywhere in this repo. Every string MerchGrid touches stays a string end to end. Look at `normalizeVariant` in `app/packages/catalog-core/src/normalize.ts` (lines 70-107): `productTitle.trim()`, `variantTitle.trim()`, `nullIfBlank(variant.sku)` — every operation here is a plain JS string method, not a subword split. The `CatalogFinding.explanation` field defined in `app/packages/catalog-checks/src/contract.ts` (line 19) is a hand-written English sentence baked into each check file (e.g. `mg-003.ts` line 32: a template string with the merchant's threshold interpolated in) — a human wrote that sentence once, at build time, and it's returned verbatim. No tokenizer ever runs on it, because nothing downstream is a model that needs tokens.

If MerchGrid ever builds the AI-assisted bulk editor, the seam would attach where a merchant's free-text prompt (spec §25.4: "Merchant prompt or CSV") first gets sent to an LLM provider — speculatively inside a new `app/app/services/ai/` module, immediately before whatever HTTP call wraps the provider's API. That's also where token-count budgeting would need to happen (see `06-token-economics.md`) before the call is made, since the provider's own tokenizer determines cost and context-window fit, and you can't know either without running the same tokenization the provider will run.

### Move 3 — the principle

A tokenizer is a fixed, offline-built lookup that turns arbitrary text into a bounded vocabulary of subword integers — it exists because the model's math only operates on numbers of a fixed dimensionality, and no vocabulary can memorize every possible string, so the vocabulary is built out of statistically common *pieces* of strings instead. Every downstream property you care about — cost, context-window fit, "can the model see individual letters" — is a direct consequence of that one design choice.

## Primary diagram

```
Primary diagram — the tokenization boundary, and where it isn't in MerchGrid

  human-readable text ──► [ BPE-style tokenizer, model-specific,   ──► token IDs
  ("MerchGrid flagged      built once offline from a training           (what the
   mg-003")                corpus, applied per request at inference)    model sees)

  MerchGrid: Catalog Audit today  →  no box like this exists;
                                      every layer in the repo works on strings
  MerchGrid: Bulk AI (roadmap)    →  would attach at the entry to a new
                                      services/ai/ module, before any
                                      provider API call
```

## Elaborate

Byte-Pair Encoding was originally a 1994 data-compression algorithm (Philip Gage), repurposed for NLP subword segmentation around 2015-2016 and adopted by GPT-2 onward. The core insight that made it stick for language modeling — build the vocabulary from corpus statistics, not linguistic rules — is what generalizes to every subword scheme since (SentencePiece, WordPiece, tiktoken's byte-level BPE). The thing worth knowing beyond the mechanism: tokenizers are versioned artifacts tied to a specific model family, which is exactly why `08-provider-abstraction.md`'s seam matters — swap the model provider and you silently change token counts, cost, and even which strings compress well, without changing a single line of your prompt.

## Project exercises

### Build a token-count estimator for the future prompt path

- **Exercise ID:** EX-1
- **What to build:** A small standalone utility, `app/app/services/ai/estimate-tokens.ts`, that takes a string and a rough chars-per-token ratio (a simple heuristic estimator, not a real tokenizer) and returns an estimated token count and estimated cost given a hypothetical per-1K-token price. Wire it as a pure function with unit tests covering short strings, long strings, and strings full of SKU-style identifiers (`SKU-0042-XL`) to show how poorly those compress relative to English prose.
- **Why it earns its place:** It's the smallest possible artifact that proves you understand token count isn't character count — and it's the exact kind of guardrail a real `services/ai/` layer would need before ever calling a real provider, so the effort isn't wasted even as a stub.
- **Files to touch:** New file `app/app/services/ai/estimate-tokens.ts`; new test `app/app/services/ai/estimate-tokens.test.ts`.
- **Done when:** The test suite demonstrates that a string of 5 SKU-style identifiers estimates to noticeably more tokens-per-character than a string of 5 common English words of similar length.
- **Estimated effort:** 1 hour.

## Interview defense

**Q: Why can't an LLM reliably count letters in a word or reverse a string?**
A: Because it never sees individual characters — it sees tokens, and a common word is usually one or two opaque token IDs, not a sequence of characters. Ask GPT to reverse "strawberry" and it's manipulating 2-3 tokens it can't decompose, not 10 letters. The failure is a direct, mechanical consequence of the tokenization boundary, not a reasoning bug.

```
  "strawberry" → tokens: [ "str", "aw", "berry" ]  (illustrative split)
  model reasons over 3 opaque IDs — it has no direct view of the 10 characters
```

**Q: Does MerchGrid's catalog-normalization code do anything like tokenization?**
A: No, and it's worth being precise about why that's not the same thing. `normalizeVariant` (`app/packages/catalog-core/src/normalize.ts` lines 70-107) does string normalization — trim whitespace, lowercase a SKU for duplicate comparison — but it never breaks strings into a fixed subword vocabulary or produces integer IDs a model consumes. It's canonicalization for exact-match comparison (`mg-005`'s duplicate-SKU check), a completely different problem from compressing arbitrary text into a bounded vocabulary for a neural network's input layer.

**Q: If MerchGrid built the bulk-AI feature, where would tokenization become a concern, concretely?**
A: The instant a merchant's free-text prompt (spec §25.4's "Merchant prompt or CSV") is about to be sent to an LLM provider. That's also exactly where you'd need a token-count check before the call — to estimate cost and confirm you're inside the provider's context window — which is why token counting and provider selection (`08-provider-abstraction.md`) show up together in any real implementation of that seam.

## See also

- `01-what-an-llm-is.md` — the autoregressive loop this file's "tokens in" step feeds.
- `03-sampling-parameters.md` — what happens on the output side of the same vocabulary.
- `06-token-economics.md` — why token count (not character count) is the unit of cost and context-window budget.
- `app/packages/catalog-core/src/normalize.ts` — the real string-normalization code in this repo, useful as a contrast case for what tokenization is *not*.
