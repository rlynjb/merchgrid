# RAG (Retrieval-Augmented Generation)

Industry standard — the pattern of retrieving relevant content and inserting it into an LLM's prompt so the model answers grounded in specific, current data instead of relying only on what it memorized during training.

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*  → deterministic Remix loaders/actions,  │
  │  no chat interface, no free-text generation surface          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*  → runs 10 hand-written rule checks│
  │  (MG-001..MG-010), no LLM call anywhere in the request path  │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks — deterministic validation logic    │
  │  packages/catalog-core                                       │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Shop, ShopSettings, Scan, Finding,         │
  │  ScanArtifact — structured relational rows, not a corpus      │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no LLM anywhere; no retrieval step; no generation ★  │ │
  │   │  ★ step — RAG requires all three, this app has none ★   │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

RAG is the combination of everything covered so far in this sub-section (embed, index, retrieve, optionally rerank) plus one new step: hand the retrieved content to an LLM as context and let it generate an answer grounded in that content, instead of relying purely on what the model memorized during pretraining. This entire app is a deterministic, rule-based catalog auditor — ten hand-written checks (MG-001 through MG-010) that produce structured `Finding` rows, with zero LLM calls anywhere. Per the product spec (§2.1): "Findings come from explicit validation rules rather than an LLM." §17.6 explicitly bans AI-powered messaging for this MVP. There is no LLM generation step to augment with retrieval, which means RAG — the combination of retrieval *and* generation — cannot exist here even partially; you'd need both halves, and this app has neither.

## Structure pass

**Layers.** RAG is a composition of two previously-separate systems glued together: a retrieval pipeline (everything in `01` through `07` of this sub-section) and a generation step (an LLM call). The axis worth tracing is **where does the answer's content actually come from?**

**Axis: source of truth for the answer.** In a pure LLM chat system with no RAG, the answer comes entirely from the model's frozen training-time weights — no way to update it without retraining or fine-tuning. In RAG, the answer's *facts* come from retrieved documents (which can be updated freely, any time, without touching the model), while the model only supplies the *language* — how to phrase, summarize, and synthesize those facts into a coherent response. This app's answer to "is this listing broken" comes from neither of those — it comes from a deterministic rule evaluated against structured data (e.g. MG-003's margin check comparing `price` against `unitCost`), with no language model synthesizing anything.

**Seam.** The seam RAG is built around is "what the model doesn't know" vs "what's in your data." A model trained on public internet text doesn't know your company's return policy updated last Tuesday, or the contents of your private product catalog — RAG's entire reason to exist is bridging that gap by handing the model your private/current data at request time instead of trying to bake it into the weights. This app's "private/current data" (the shop's live catalog, via the Shopify Admin API) is consumed directly by deterministic check functions — never handed to a model, because there's no model consuming anything.

## How it works

**Move 1 — the mental model.** You already know the shape of "fetch data, then render it" — a component calls `fetch()`, gets JSON back, and renders it into the UI rather than hardcoding the content into the component. RAG is the LLM-analog of that: instead of hardcoding facts into the model's weights (impossible to update per-request anyway), you fetch the relevant facts at request time and hand them to the model to render into a coherent natural-language answer.

```
  Pattern — retrieve, augment, generate

  user query ──► [retrieve top-k relevant chunks] ──► [insert into prompt] ──► [LLM generates answer]
                          ▲                                     │
                          │                                     ▼
                   your corpus/index                    answer grounded in
                   (01-10 of this sub-section)           retrieved content, not
                                                          just training-time memory
```

**Move 2 — the mechanism, step by step.**

**Step 1: retrieve.** Given a user query, run it through whatever retrieval pipeline you've built — sparse, dense, hybrid+RRF, optionally reranked (`01` through `07` of this sub-section) — and get back the top-k most relevant chunks of source content.

**Step 2: augment — build the prompt.** Concatenate the retrieved chunks into the LLM's context window, typically with instructions telling the model to answer *using only* the provided context (to reduce hallucination) and to say "I don't know" if the context doesn't cover the question.

```
  Pseudocode — the augmentation step

  function buildRagPrompt(userQuery, retrievedChunks):
    contextBlock = joinWithSeparators(retrievedChunks)
    prompt = """
      Answer the question using ONLY the context below.
      If the context doesn't contain the answer, say so — do not guess.

      Context:
      {contextBlock}

      Question: {userQuery}
    """
    return prompt
```

**Step 3: generate.** Send the augmented prompt to the LLM. The model's job is now narrower than open-ended generation — synthesize and phrase an answer *from the supplied context*, rather than reason from its own training-time knowledge. This is the step that most reduces hallucination risk (though doesn't eliminate it — a model can still ignore the context and answer from memory, or misread the context).

```
  Layers-and-hops — RAG request flow (general pattern, absent here)

  ┌─ User ─────┐  hop 1: question         ┌─ App server ──────┐
  │             │ ────────────────────────►│                     │
  └─────────────┘  hop 4: answer      ◄────┤  orchestrates:      │
                                             │  retrieve → augment │
                                             │  → generate          │
                                             └──┬───────────┬────────┘
                                   hop 2: query  │           │ hop 3: prompt
                                   vector/text    ▼           ▼ + context
                                       ┌─ Retrieval ─┐  ┌─ LLM ──────┐
                                       │ index (01-07)│  │ generation  │
                                       └──────────────┘  └────────────┘
```

**Step 4: (optional, but standard in production) cite sources.** Because you know exactly which chunks were retrieved, you can attribute the generated answer back to specific source documents — something a pure chat model fundamentally cannot do, since it has no notion of "which training document" any given fact came from.

**In this codebase: not yet implemented, and none of the three pieces exist.** No retrieval pipeline (covered exhaustively above — `Finding.searchText`'s sparse filter is the one partial exception, and it's not paired with anything). No LLM call anywhere in `app/app` or `app/packages`. No prompt-construction/augmentation step. RAG needs all three; this app has zero of them. This is a deliberate product decision, not a gap to fill — the product spec is explicit that findings must come from auditable, explicit rules, not LLM inference, because a merchant needs to trust *why* a finding fired, and "the model said so" is a categorically worse trust story than "MG-003 fired because `unitCost` exceeds `price` × (1 - minimumMarginPercent)."

**Move 3 — the principle.** RAG earns its place specifically when you have an LLM that needs to answer questions using content it can't reliably know from training alone — private data, frequently-changing data, or data too voluminous to fit in a prompt without retrieval narrowing it down first. When there's no LLM in the loop at all, or when the "answer" is a deterministic computation over structured data rather than a natural-language synthesis task, RAG isn't a lighter-weight version of the right architecture — it's the wrong architecture entirely, solving a problem that doesn't exist.

## Primary diagram

```
  Full picture — RAG pipeline vs this app's real pipeline, side by side

  ┌─ RAG (general pattern, NOT in this codebase) ──────────────────────┐
  │  query → retrieve (01-07) → augment prompt → LLM generates answer   │
  │  answer's facts come from retrieved docs; model supplies language    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ this app's real pipeline (deterministic, no LLM) ───────────────────┐
  │  Shopify catalog data → MG-001..MG-010 rule checks (catalog-checks)   │
  │  → Finding rows (explanation string is template-generated, not        │
  │  model-generated) → Prisma/SQLite → Remix UI                          │
  │  answer's facts AND language both come from explicit code             │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

RAG (the term and the technique) comes from a 2020 Facebook AI Research paper, and it took off in production because it solves the two hardest problems with pure LLM knowledge cheaply: staleness (the model's knowledge is frozen at training time; retrieval isn't) and hallucination on private/specific data (a model has no way to know your internal docs unless you show it, at request time, what's actually in them). It connects to every other file in this sub-section as the "why" — embeddings, chunking, vector databases, dense/sparse, hybrid+RRF, reranking, and query rewriting all exist because *some* system downstream (usually RAG) needs a high-quality retrieval stage feeding it. Remove the generation step and you just have a search engine; remove the retrieval step and you just have a chatbot with no grounding — RAG is specifically the combination, and the phrase gets misapplied constantly to systems that are really just "search" (no LLM synthesis) or "chatbot with some context stuffed in" (no real retrieval quality bar). Being precise about which half a system actually has is worth the pedantry — it's the difference between diagnosing a retrieval-quality bug and a prompt-engineering bug when something goes wrong.

## Project exercises

### EX-1 — build a toy RAG loop over `Finding` explanations, entirely outside the app

- **Exercise ID:** EX-1
- **What to build:** A standalone script that takes a natural-language question about one scan (e.g. "which pricing problems are most severe?"), retrieves the top-k relevant `Finding` rows using the dense-search prototype from `05-dense-vs-sparse.md`'s exercise, builds a RAG-style prompt from those rows' `explanation` text, and sends it to an LLM to generate a synthesized natural-language answer — then reads the answer and checks it against the actual retrieved findings for accuracy.
- **Why it earns its place:** This is the exercise that makes "RAG needs both retrieval and generation" undeniable, because you'll build both halves from scratch, outside the product, using real `Finding` data — and you'll see firsthand how the deterministic `MG-00x` explanation strings this app already generates are a completely different (and, for this product's trust requirements, better) mechanism than having an LLM synthesize an answer.
- **Files to touch:** new file, e.g. `app/scripts/toy-rag-loop.ts` (standalone; calls an LLM API, reuses retrieval scaffolding from `05-dense-vs-sparse.md`'s exercise, never imported by app code).
- **Done when:** you have one worked example where the LLM's generated answer correctly reflects the retrieved findings, and you can articulate in one sentence why this app doesn't use this pattern for its actual finding explanations.
- **Estimated effort:** 1-2 hours, assuming the retrieval scaffolding from earlier exercises already exists.

## Interview defense

**Q: Does this app need RAG?**
No, and this is worth being direct about rather than hedging. RAG requires an LLM generating answers over content it can't otherwise access — this app has no LLM anywhere in its request path and no unstructured corpus to retrieve over. Its findings come from ten deterministic rule checks (MG-001..MG-010) evaluated against typed, structured catalog data. RAG solves "help a language model answer accurately using data it doesn't know" — a problem this app fundamentally doesn't have, because nothing here is asking a language model to answer anything.

**Q: If MerchGrid ever added an LLM-powered feature, would it need RAG?**
Depends entirely on what the feature does. A hypothetical "explain this finding in plain language, citing similar past findings" feature would have a retrieval component (similar past `Finding` rows) feeding an LLM's generation — that would be RAG. This is explicitly speculative: not planned, not in the product spec, and the product's stated MVP scope (§17.6) bans AI-powered messaging outright. A different hypothetical — bulk AI-assisted catalog editing (mentioned as a possible separate future product, "MerchGrid: Bulk AI") — might use an LLM for generation without needing retrieval at all, if it's just rewriting text the user already selected rather than answering a question that needs grounding in a larger corpus. Not every LLM feature needs RAG; only ones where the model needs facts it can't already see in its immediate input.

**Q: What's the single most common mistake when people say a system "uses RAG"?**
Calling something RAG when it's really just one half — a search feature with no generation step (that's just retrieval), or a chatbot that gets some context stuffed into its prompt with no real retrieval-quality engineering behind it (that's a chatbot with weak grounding, not RAG in the sense the term is meant to convey). Precision here matters because the failure modes of a retrieval bug and a generation/prompting bug are completely different to diagnose.

## See also

- `01-embeddings.md` through `08-query-rewriting-hyde.md` — the retrieval half RAG depends on
- `09-stale-embeddings.md` and `10-incremental-indexing.md` — keeping RAG's retrieval corpus current
- `12-graphrag.md` — a structural variant of RAG for relationship-heavy queries
- `../04-agents-and-tool-use/` — where an LLM deciding *when* to retrieve (rather than always retrieving) lives
