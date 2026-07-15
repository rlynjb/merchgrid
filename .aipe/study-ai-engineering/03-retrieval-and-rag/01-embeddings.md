# Embeddings

Industry standard — vector representation of unstructured content, the substrate every retrieval system is built on.

## Zoom out, then zoom in

Here's the whole app, top to bottom:

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*  →  loader/action                       │
  └──────────────────────────┬─────────────────────────────────┘
                             │ calls
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*  (scan-api, runner, queue)         │
  └──────────────────────────┬─────────────────────────────────┘
                             │ calls
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks — MG-001..MG-010 rule checks       │
  │  packages/catalog-core                                      │
  └──────────────────────────┬─────────────────────────────────┘
                             │ persists rows
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Shop, ShopSettings, Scan, Finding,        │
  │  ScanArtifact — plain relational rows                       │
  │                                                              │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ embeddings — no vector column, no embedding call ★ │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

An embedding is a fixed-length vector of floats that represents a piece of unstructured content — text, an image, audio — such that "similar in meaning" maps to "close in vector space." That's the whole concept, and every downstream retrieval pattern (vector databases, hybrid search, RAG) is built on top of it. This app has no unstructured corpus and no LLM consuming one, so it never needed this.

## Structure pass

**Layers.** Embeddings live between "raw content" and "a searchable index." Split any embedding pipeline into three altitudes: the source (documents, rows, chunks), the embedding model (a frozen neural net that maps text → vector), and the index (where the vectors get stored for similarity search — covered in `04-vector-databases.md`).

**Axis: what does "closeness" mean at each layer?** At the source layer, closeness is undefined — a string is just characters. At the model layer, closeness is a geometric property the model was trained to produce (cosine similarity between two output vectors). At the index layer, closeness becomes a *query* — "give me the k nearest vectors to this one."

**Seam.** The load-bearing seam is between "text" and "vector" — the embedding call itself. Everything on the text side is human-readable and diffable; everything on the vector side is a list of floats with no inherent meaning without the model that produced it. Cross that seam and you can no longer eyeball the data — you need the same model (or a compatible one) to turn a query back into a comparable vector. This app has nothing on either side of that seam: `Finding.explanation` and `Finding.searchText` are stored and queried as plain strings, never turned into vectors.

## How it works

**Move 1 — the mental model.** You already know what a hash function does: turn arbitrary input into a fixed-size fingerprint, deterministically. An embedding model does something similar, but instead of a fingerprint that's either equal or not, it produces a fingerprint where *distance* is meaningful — two hashes of similar strings look nothing alike, but two embeddings of similar *meanings* land near each other in the vector space.

```
  Pattern — text collapses into geometry

  "the shirt runs small"  ──► embed() ──► [0.12, -0.87, 0.03, ...]
  "sizing is undersized"  ──► embed() ──► [0.15, -0.81, 0.02, ...]
  "warehouse delivery ETA"──► embed() ──► [0.91,  0.02, -0.44, ...]

                    close in vector space          far in vector space
                    (similar meaning)               (unrelated meaning)
```

**Move 2 — the mechanism, step by step.**

**Step 1: tokenize the input.** The embedding model doesn't see characters; it sees tokens (subword units). "undersized" might split into `under` + `sized`. This step is identical to how any transformer-based LLM tokenizes a prompt.

**Step 2: run the encoder forward pass.** The tokens pass through a transformer encoder (or a distilled/bi-encoder variant built for this purpose). Unlike a chat model that autoregressively generates the next token, an embedding model runs once, forward, and pools the final hidden states (usually a mean-pool or a `[CLS]`-token read) into a single fixed-length vector — 384, 768, 1536, 3072 dimensions depending on the model.

```
  Pseudocode — the encode step

  function embed(text):
    tokens = tokenizer.encode(text)          // subword tokens, fixed vocab
    hidden_states = encoder.forward(tokens)  // one vector per token
    vector = pool(hidden_states)             // mean-pool or CLS-token
    vector = normalize(vector)               // unit length, so cosine == dot product
    return vector                            // fixed length regardless of input length
```

**Step 3: normalize.** Almost every embedding pipeline L2-normalizes the output vector to unit length. This is the detail people forget: once every vector has length 1, cosine similarity between two vectors collapses to a plain dot product — which is why vector databases default to dot-product or cosine distance, not Euclidean.

**Step 4: store or compare.** The vector by itself is useless without either (a) another vector to compare it to (cosine similarity, one comparison) or (b) an index of many vectors to search over (approximate nearest neighbor, covered in `04-vector-databases.md`).

**In this codebase: not yet implemented.** There is no embedding call anywhere in `app/app` or `app/packages`. The closest thing to "represent content for matching" is `Finding.searchText` (`app/prisma/schema.prisma:118-122`) — a lowercased, space-joined concatenation of `productTitle`/`variantTitle`/`sku`/`barcode`, matched with SQLite's `contains` operator in `app/app/services/scan/scan-api.server.ts:254-262`. That's exact substring matching on a denormalized string, not a vector — see `05-dense-vs-sparse.md` for the full contrast.

**Move 3 — the principle.** An embedding is a lossy, learned compression of meaning into geometry — you trade the ability to read the representation for the ability to *compare* it cheaply, at scale, across anything the model was trained to understand. That tradeoff only pays for itself when you have unstructured content and a fuzzy-similarity question to ask of it. This app's data is structured rows behind typed columns; every query it needs ("findings with this checkId," "findings containing this SKU") is already exact-match, so there's no fuzzy-similarity question to buy an embedding for.

## Primary diagram

```
  Full picture — embedding pipeline (general pattern, absent here)

  ┌─ source ──────────┐   ┌─ embedding model ─────┐   ┌─ vector ──────────┐
  │ raw text / chunk   │──►│ tokenize → encode →    │──►│ [0.12,-0.87,...]  │
  │ (doc, row, field)  │   │ pool → normalize       │   │ fixed-length,     │
  └────────────────────┘   └────────────────────────┘   │ unit norm         │
                                                          └─────────┬─────────┘
                                                                    │ stored in
                                                          ┌─────────▼─────────┐
                                                          │ vector index /     │
                                                          │ vector database     │
                                                          │ (04-vector-        │
                                                          │  databases.md)      │
                                                          └────────────────────┘
```

## Elaborate

Embeddings predate LLMs by a decade — word2vec (2013) and GloVe learned static per-word vectors from co-occurrence statistics. Modern embeddings (OpenAI's `text-embedding-3`, Cohere's `embed-v3`, open models like BGE or E5) are sentence/passage-level, produced by transformer encoders fine-tuned specifically for retrieval (contrastive loss: pull matching query/passage pairs together, push mismatched pairs apart). That fine-tuning objective is why an embedding model is a different artifact from a chat model even when both start from a similar transformer backbone — see `02-embedding-model-choice.md` for how to pick one. Once you have vectors, the next question is where they live at scale, which is `04-vector-databases.md`.

## Project exercises

### EX-1 — embed real `Finding` rows and compute similarity by hand

- **Exercise ID:** EX-1
- **What to build:** A standalone script (not wired into the app) that loads all `Finding` rows for one completed scan from the SQLite database, calls a local or API embedding model on each row's `explanation` text, and prints the cosine similarity between every pair of findings for that scan.
- **Why it earns its place:** This app has real `Finding.explanation` text sitting in the database right now and has never once turned it into a vector. Running that conversion yourself, on data you already understand, is the fastest way to see what an embedding actually captures — and just as importantly, what it doesn't (two findings about the same `checkId` but different products may or may not land close together; you won't know until you look).
- **Files to touch:** new file, e.g. `app/scripts/explore-embeddings.ts` (standalone, reads via `@prisma/client` directly, never imported by app code).
- **Done when:** the script prints a similarity matrix for one scan's findings and you can point at the highest- and lowest-similarity pair and explain in one sentence why the model scored them that way.
- **Estimated effort:** 1-2 hours (embedding API key or a local model via `transformers.js`/`sentence-transformers`, plus a cosine-similarity function you write by hand — don't import one).

## Interview defense

**Q: What's the difference between an embedding and a hash?**
A hash is designed so similar inputs produce *unrelated* outputs (avalanche effect) — that's the whole point, it prevents collisions from leaking structure. An embedding is designed so similar inputs produce *nearby* outputs — structure leaking through is the entire value proposition.
```
  hash("cat") = 0x8f3a...     hash("cats") = 0x1c92...    (unrelated, by design)
  embed("cat") ≈ [0.4,0.1]    embed("cats") ≈ [0.41,0.09] (nearby, by design)
```

**Q: Does this app need embeddings anywhere right now?**
No. Embeddings solve "find content that's semantically similar to a query" over an unstructured corpus. Every lookup in this app is a structured, typed query against relational columns — `checkId`, `severity`, `scanId` — with exact-match filtering already indexed (`@@index([scanId, severityRank, checkId])` in `app/prisma/schema.prisma:123-124`). There's no free-text corpus to search semantically over.

**Q: What breaks if you skip normalization?**
Cosine similarity is `dot(a,b) / (|a| * |b|)`. If you skip normalizing and just take the dot product, longer vectors (which can happen with longer input text, depending on pooling) score artificially higher regardless of actual semantic closeness — you'd be measuring magnitude, not direction.

## See also

- `02-embedding-model-choice.md` — which model to pick and why
- `04-vector-databases.md` — where the vectors get stored and searched
- `05-dense-vs-sparse.md` — this app's one real (partial) anchor, `Finding.searchText`
