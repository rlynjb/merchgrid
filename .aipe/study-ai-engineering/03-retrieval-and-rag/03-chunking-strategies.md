# Chunking strategies

Industry standard — splitting long documents into retrieval-sized units before embedding (fixed-size, semantic, recursive, and document-structure-aware chunking).

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*                                          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*                                    │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite — Finding rows are already small,          │
  │  atomic units (one row per violation), never long           │
  │  documents needing to be split                               │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no chunking — nothing here is long-form text that ★│ │
  │   │  ★ needs splitting before it could be embedded ★       │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

Chunking answers one question: when a document is too long to embed as a single unit (or too long to be a *useful* single retrieval unit — a 50-page PDF embedded whole gives you a vector so averaged-out it matches nothing precisely), how do you split it into pieces that are each small enough to embed meaningfully and large enough to preserve context? This app has no long documents anywhere in its data model — `Finding` rows are already atomic, one row per rule violation, with short structured fields. There's nothing to chunk.

## Structure pass

**Layers.** Chunking sits between "raw document" and "embedding" (`01-embeddings.md`) — it's a preprocessing step, not a standalone system. The axis worth tracing: **information density per unit**. A whole document has low density per token (mixed topics, boilerplate); a single sentence has high density but low context (an isolated sentence often doesn't make sense without its paragraph). Chunking is the search for the sweet spot.

**Seam.** The seam is between "how the document is naturally structured" (headings, paragraphs, code blocks) and "how the chunker imposes structure" (fixed character counts). Naive chunkers ignore the natural seam and cut mid-sentence or mid-table; better chunkers respect it. Every chunking bug traces back to this seam being violated somewhere.

## How it works

**Move 1 — the mental model.** You already understand a `.map()` over an array with a `slice()` inside it — take a big collection, produce fixed-size windows. Chunking is exactly that, applied to text, with the added wrinkle that a naive slice can cut a sentence in half, so real chunkers add overlap and boundary-awareness on top of the basic windowing.

```
  Pattern — sliding window with overlap

  document: [───────────────────────────────────────────────]

  chunk 1:  [────────────]
  chunk 2:          [────────────]
  chunk 3:                  [────────────]
                    ▲───▲
                overlap region — shared context so a fact
                split across chunk boundaries isn't lost entirely
```

**Move 2 — the strategies, step by step.**

**Strategy 1: fixed-size chunking.** Split every N characters or N tokens, with an overlap of M tokens between consecutive chunks. Simplest to implement, cheapest to compute, and the default in most RAG starter tutorials — but it's blind to structure, so it will cut a sentence, a code block, or a table row in half whenever the boundary falls there.

```
  Pseudocode — fixed-size with overlap

  function chunkFixed(text, chunkSize, overlap):
    chunks = []
    start = 0
    while start < length(text):
      end = min(start + chunkSize, length(text))
      chunks.append(text[start:end])
      start = end - overlap   // step forward, re-covering the overlap region
    return chunks
```

**Strategy 2: recursive/structure-aware chunking.** Split on the document's natural hierarchy first — try splitting on `\n\n` (paragraphs); if a resulting piece is still too long, split on `\n` (lines); if still too long, fall back to sentence boundaries; only fall back to a hard character cut as a last resort. This is what LangChain's `RecursiveCharacterTextSplitter` does, and it's the practical default because it respects structure most of the time and only degrades to fixed-size chunking when it has to.

**Strategy 3: semantic chunking.** Instead of a fixed size, embed sentences one at a time and cut a new chunk wherever consecutive sentence embeddings show a big similarity drop — the idea being that a topic shift in the text should also be a chunk boundary. More expensive (an embedding call per sentence just to decide where to cut), but produces chunks that are topically coherent rather than arbitrarily sized.

**Strategy 4: document-structure-aware chunking.** For structured source formats (Markdown, HTML, code), split along the document's own markup — one chunk per Markdown section, one chunk per function definition. This is the highest-fidelity approach when the source format actually has semantic structure to exploit, and it's why code-search tools chunk by function/class rather than by character count.

```
  Comparison — same document, four strategies

  ┌────────────────┬────────────────────────────────────────┐
  │ fixed-size      │ cheap, blind to structure, cuts anywhere│
  │ recursive        │ respects structure, falls back gracefully│
  │ semantic          │ topically coherent, costs an embed pass │
  │ structure-aware   │ highest fidelity, needs parseable format│
  └────────────────┴────────────────────────────────────────┘
```

**In this codebase: not yet implemented.** There's no chunker anywhere in `app/app` or `app/packages` because there's no long-form content to split. Every piece of text this app stores — `Finding.explanation`, `Finding.productTitle`, `Finding.evidenceJson` — is already a short, atomic field written once at scan time (`app/app/services/scan/runner.server.ts`) and read as a whole value, never split or reassembled.

**Move 3 — the principle.** Chunking is a lossy tradeoff between context and precision, and the "right" chunk size is a property of your *queries*, not your documents — a chunk that's the perfect size for "what does this contract say about termination" is the wrong size for "summarize this entire contract." Pick the strategy that matches how granular your retrieval question actually is, not the one that's easiest to implement.

## Primary diagram

```
  Full picture — chunking as a preprocessing stage (general pattern)

  ┌─ raw document ──┐  ┌─ chunker ─────────────┐  ┌─ chunks ────────┐
  │ 50-page PDF,      │─►│ fixed / recursive /    │─►│ N pieces, each   │
  │ long article,      │  │ semantic / structure-  │  │ independently     │
  │ full transcript    │  │ aware, with overlap    │  │ embeddable        │
  └────────────────────┘  └────────────────────────┘  └────────┬─────────┘
                                                                 │ feeds
                                                       ┌─────────▼─────────┐
                                                       │ 01-embeddings.md   │
                                                       └────────────────────┘
```

## Elaborate

Chunk size interacts directly with the embedding model's context window (most embedding models cap input at 512-8192 tokens) and with how the chunk will be used downstream — a chunk destined for RAG (`11-rag.md`) needs to carry enough context to be useful when pasted into a prompt verbatim, while a chunk destined purely for similarity search can be smaller since it only needs to be *findable*, not *readable in isolation*. Overlap size is itself a tuning knob: too little overlap and a fact spanning a chunk boundary gets lost entirely; too much overlap and you're paying to embed and store redundant text. There's no universal right answer — teams converge on chunk size empirically, by running retrieval evals (see the evals sub-section of this study guide) against their actual query set.

## Project exercises

### EX-1 — chunk `Finding.evidenceJson` payloads and observe when chunking is unnecessary

- **Exercise ID:** EX-1
- **What to build:** A standalone script (not wired into the app) that pulls `Finding.evidenceJson` and `Finding.explanation` for every finding in one scan, measures their character/token length, and prints a one-line verdict per row: "would need chunking" (over some threshold you pick, e.g. 2000 characters) vs "fits in one chunk as-is."
- **Why it earns its place:** The fastest way to internalize "chunking is conditional, not automatic" is to run the length check against real data and see every row come back short. This app's structured, denormalized fields (spec-driven, by design — see `Finding.evidenceJson`'s comment in `app/prisma/schema.prisma`) were built to be self-contained and small; measuring that directly makes the "no chunking needed" claim verifiable rather than asserted.
- **Files to touch:** new file, e.g. `app/scripts/measure-finding-lengths.ts` (standalone, reads via Prisma directly).
- **Done when:** the script reports the max, median, and p95 length across all findings in a scan, and you can state whether any realistic `Finding` row in this app's data model would ever cross a typical chunking threshold.
- **Estimated effort:** 30-45 minutes.

## Interview defense

**Q: When would fixed-size chunking with no overlap actively lose information?**
Whenever a fact spans the exact cut point. If a document says "the warranty is void if... [chunk boundary] ...the item is used commercially," neither chunk alone answers "when is the warranty void" — the fact was split in half. Overlap is the direct fix.

**Q: Why not always use the most expensive, highest-fidelity chunking strategy (semantic or structure-aware)?**
Cost and complexity scale with what the source format supports and what the query pattern demands. Semantic chunking needs an embedding call per candidate boundary just to decide where to cut — that's real latency and cost paid before you've even indexed anything. If your source is unstructured plain text and your queries don't need topic-perfect boundaries, recursive chunking gets you 90% of the benefit for a fraction of the cost.

**Q: Does this app need chunking anywhere?**
No — chunking exists to make long documents embeddable in retrieval-sized pieces, and this app has no long documents. Every text field it stores (`Finding.explanation`, `productTitle`, etc.) is already short and atomic by schema design, so there's nothing to split.

## See also

- `01-embeddings.md` — what happens to a chunk once it's produced
- `10-incremental-indexing.md` — re-chunking and re-embedding when a document changes
- `11-rag.md` — where chunk size interacts with prompt context budget
