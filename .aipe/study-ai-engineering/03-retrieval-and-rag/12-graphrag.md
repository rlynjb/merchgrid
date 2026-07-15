# GraphRAG

Industry standard — a RAG variant that retrieves over a knowledge graph (entities + relationships) instead of (or alongside) flat vector similarity, built for questions that span relationships rather than a single relevant passage.

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
  │  Prisma / SQLite: Shop 1─N Scan 1─N Finding — this IS a      │
  │  relational graph of foreign keys, but queried by ordinary    │
  │  SQL joins, never by graph-traversal-for-LLM-context           │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no knowledge graph construction, no LLM traversing ★│ │
  │   │  ★ relationships to build context, no RAG at all       ★│ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

Plain RAG (`11-rag.md`) retrieves independent chunks ranked by similarity to a query — great when the answer lives in one passage, bad when the answer requires connecting facts *across* multiple documents through relationships (e.g. "which of our suppliers are affected by the policy change announced in Q3" — no single document says this; you have to know supplier→product→policy relationships and traverse them). GraphRAG builds an explicit knowledge graph (entities as nodes, relationships as edges, usually LLM-extracted from source documents) and retrieves by graph traversal or community summarization instead of pure vector similarity. This app has a real relational graph in its schema (`Shop` → `Scan` → `Finding`, all foreign-key relationships) — but it's queried with ordinary SQL joins for structured lookups, never traversed to assemble context for an LLM, because there's no LLM consuming anything here.

## Structure pass

**Layers.** GraphRAG sits at the same altitude as plain RAG — both are "retrieval feeding generation" — but they differ in what the retrieval step is built to find. The axis worth tracing is **what shape of question can retrieval actually answer?**

**Axis: single-hop vs multi-hop retrieval.** Plain vector similarity answers single-hop questions well: "what does the document about X say" — one relevant chunk, one lookup. It answers multi-hop questions poorly: "what does X's supplier's policy say about Y" requires traversing through an intermediate entity (the supplier) that a single similarity search has no mechanism to walk through. GraphRAG's entire reason to exist is making that traversal a first-class retrieval operation instead of hoping one lucky chunk happens to mention all the connected facts at once.

**Seam.** The seam is between "retrieval is a similarity lookup" and "retrieval is a graph query." This app's foreign-key relationships (`Finding.scanId` → `Scan.id`, `Scan.shopId` → `Shop.id`) are real graph edges in a relational sense, and they're traversed constantly — but through SQL `JOIN`s and Prisma relation includes, evaluated deterministically by the query planner, never through an LLM reasoning over graph structure to assemble unstructured context.

## How it works

**Move 1 — the mental model.** You already know the difference between a flat list of search results and a graph traversal — think of LinkedIn's "second-degree connection" feature versus a plain keyword search of people's names. A keyword search can't tell you "who does my connection know" — that requires walking an actual graph edge (my connection → their connections). GraphRAG is that same move applied to retrieval: instead of "which chunk is similar to my query," it's "which entities and relationships, walked from my query's starting point, answer this."

```
  Pattern — flat similarity retrieval vs graph traversal retrieval

  plain RAG:                          GraphRAG:
    query ──► [similarity search]        query ──► [identify starting entity]
                    │                                     │
                    ▼                                     ▼
             top-k similar chunks              [traverse graph edges N hops]
             (independent, unordered)                     │
                                                           ▼
                                                  [connected entities +
                                                   relationships, structured]
```

**Move 2 — the mechanism, step by step.**

**Step 1: graph construction (the expensive, offline part).** An LLM processes the source corpus and extracts entities (people, organizations, products, concepts) and relationships between them ("Supplier A supplies Product B," "Policy C affects Product B"), building a knowledge graph. This is itself an LLM-generation task — extraction quality directly bounds retrieval quality later, and it's expensive to run over a large corpus (one or more LLM calls per document, not per query).

```
  Pseudocode — graph construction (offline, one-time or periodic)

  function buildKnowledgeGraph(documents, llm):
    graph = emptyGraph()
    for doc in documents:
      extraction = llm.complete(
        prompt = "Extract entities and relationships from this text: " + doc.content
      )
      // extraction = [{ entityA, relationship, entityB }, ...]
      for triple in extraction:
        graph.addNode(triple.entityA)
        graph.addNode(triple.entityB)
        graph.addEdge(triple.entityA, triple.relationship, triple.entityB)
    return graph
```

**Step 2: (Microsoft's GraphRAG variant) community detection and summarization.** Beyond raw entities and edges, the specific "GraphRAG" technique popularized by Microsoft Research clusters the graph into communities (densely-connected sub-graphs) and has an LLM pre-generate a summary of each community — so a broad, corpus-wide question ("what are the main themes across all our supplier contracts") can be answered by reading community summaries instead of trying to traverse thousands of individual edges at query time.

**Step 3: query-time retrieval — traverse, don't just search.** Given a query, identify the relevant starting entity/entities (often via the same embedding-similarity techniques as plain RAG, used just to find the entry point into the graph), then traverse outward N hops, collecting connected entities and relationships as structured context — richer and more precisely connected than whatever chunks happened to be textually similar.

```
  Layers-and-hops — GraphRAG retrieval (general pattern, absent here)

  ┌─ query ──────┐  hop 1: find entry entity  ┌─ Knowledge graph ──┐
  │ "which items   │ ──────────────────────────►│ nodes = entities,   │
  │  are affected   │                            │ edges = relations    │
  │  by policy X"   │  hop 2: traverse N hops ◄──┤ (LLM-extracted,       │
  └─────────────────┘                             │  offline)              │
                       hop 3: connected subgraph  └──────────┬────────────┘
                       ◄─────────────────────────────────────┘
                       │
                       ▼
             ┌─ augment LLM prompt with ────┐
             │ structured entities + edges,   │
             │ not just flat text chunks       │
             └────────────────────────────────┘
```

**In this codebase: not yet implemented — and there is no LLM-extracted knowledge graph anywhere.** This app's relational schema *is* a graph in the formal sense — `Shop` 1─N `Scan` 1─N `Finding`, connected by real foreign keys — but that graph was hand-designed by a developer writing a Prisma schema, not extracted by an LLM reading unstructured text. It's queried via ordinary SQL joins (`prisma.scan.findUnique({ where: { id }, include: { findings: true } })`-style relation loading) for structured lookups like "get this scan's findings," never traversed to assemble unstructured context for a model to reason over. That's the deepest distinction worth naming: having foreign keys does not mean you have a "knowledge graph" in the GraphRAG sense — the graph GraphRAG needs is built from *unstructured text*, extracting relationships that aren't already explicit columns in a schema.

**Move 3 — the principle.** GraphRAG is the right tool specifically when your questions are inherently multi-hop and relational, and your source corpus is unstructured text where those relationships aren't already captured in a schema. When the relationships are *already* explicit and structured — foreign keys in a relational database — you don't need an LLM to extract a graph that already exists; you need a JOIN. GraphRAG is solving "how do I discover and query relationships hidden inside prose"; it's not solving "how do I query relationships I already modeled as columns."

## Primary diagram

```
  Full picture — GraphRAG vs plain RAG vs this app's real relational graph

  ┌─ GraphRAG (general pattern, NOT in this codebase) ──────────────────┐
  │  unstructured docs → LLM extracts entities/edges → knowledge graph   │
  │  → query traverses graph → structured context → LLM generates        │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ plain RAG (11-rag.md, also NOT in this codebase) ────────────────────┐
  │  unstructured docs → chunk → embed → similarity search → LLM generates│
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ this app's real relational graph (present, but not GraphRAG) ───────┐
  │  Shop —1:N→ Scan —1:N→ Finding  (hand-designed FKs, SQL JOINs,        │
  │  no LLM extraction, no LLM consuming the traversal result)             │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Microsoft Research's GraphRAG paper (2024) is the specific technique most people mean by the term today, though "retrieval over a knowledge graph" as a general idea predates it. The real cost that limits GraphRAG's adoption is the offline graph-construction step — running an LLM extraction pass over an entire corpus is expensive and needs to be re-run (or incrementally updated, see `10-incremental-indexing.md`'s concerns applied to graph edges instead of vectors) whenever the source corpus changes, which is a heavier maintenance burden than re-embedding a changed document for plain RAG. It's a specialist tool for a specific failure mode of plain RAG (multi-hop questions over document collections with real, non-obvious relationships) — reaching for it by default, before confirming plain vector RAG actually fails on your query set, is over-engineering; most RAG systems never need it.

## Project exercises

### EX-1 — model the app's real relational graph as an entity graph and contrast it with what GraphRAG would need

- **Exercise ID:** EX-1
- **What to build:** A standalone script that walks this app's actual foreign-key graph for one shop (`Shop` → its `Scan`s → each scan's `Finding`s) and prints it as an explicit entity/edge list (e.g. `Shop(shop_123) -HAS_SCAN-> Scan(scan_456) -PRODUCED-> Finding(finding_789)`), then writes a short comparison note: which of these edges were hand-declared in `schema.prisma` vs which (if any) an LLM would need to *extract* from unstructured text if this data didn't already have a schema.
- **Why it earns its place:** The core misconception GraphRAG explanations need to clear up is "having foreign keys isn't the same as having a knowledge graph in the GraphRAG sense." Walking this app's real, already-structured graph and explicitly noting that every edge is a hand-declared schema relationship (not an LLM-extracted one) makes that distinction concrete instead of asserted.
- **Files to touch:** new file, e.g. `app/scripts/print-relational-graph.ts` (standalone; reads via Prisma, prints entity/edge triples for one shop).
- **Done when:** you can point at the printed edge list and state, for each edge, "this came from a Prisma foreign key, not an LLM extraction" — and explain what would have to change for this to become a genuine GraphRAG-style knowledge graph.
- **Estimated effort:** 30-45 minutes.

## Interview defense

**Q: This app has `Shop` → `Scan` → `Finding` foreign keys. Isn't that a knowledge graph already?**
It's a graph in the formal sense (nodes and edges), but not a knowledge graph in the GraphRAG sense. GraphRAG's graph is built by an LLM extracting entities and relationships out of *unstructured* text where they weren't already explicit. This app's foreign keys were hand-declared by a developer in a Prisma schema — there's no extraction step, no ambiguity to resolve, and critically, no LLM consuming a traversal of it to generate an answer. A relational schema with foreign keys is what GraphRAG's construction step would be trying to *produce* if it didn't already exist as clean, structured data.

**Q: When would you reach for GraphRAG instead of plain RAG?**
When your questions are genuinely multi-hop over a corpus where the relationships aren't already structured data — "which of our suppliers are exposed to the risk described in this new regulation" needs to connect supplier→product→regulation facts that might live in three separate unstructured documents. If a single relevant passage usually contains the whole answer, plain RAG is simpler, cheaper, and sufficient; GraphRAG's construction cost only pays for itself when multi-hop reasoning is a recurring, real query pattern.

**Q: Does this app need GraphRAG?**
No — for two independent reasons, either of which is sufficient on its own. First, it has no LLM anywhere generating answers, so there's no generation step for any retrieval (graph-based or otherwise) to augment. Second, even its relationship data (`Shop`/`Scan`/`Finding`) is already fully structured in a relational schema with explicit foreign keys — exactly the kind of data GraphRAG's expensive extraction step exists to produce when it *isn't* already available. There's nothing here for GraphRAG to extract and nothing for it to feed.

## See also

- `11-rag.md` — the base pattern GraphRAG extends
- `01-embeddings.md` — GraphRAG still typically uses embeddings to find graph entry points
- `10-incremental-indexing.md` — the analogous maintenance problem for graph edges instead of vectors
