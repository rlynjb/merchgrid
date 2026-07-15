# System design templates

Standard interview-style system-design sketches for two AI-shaped prompts, each checked against what MerchGrid: Catalog Audit actually does. Both templates land on the honest side of "no" — this repo is a deterministic scan-and-report tool, not a search surface or a conversational one. Each file still teaches the generic architecture in full; the last two bullets ground it in real files.

- **[01-search-ranking.md](./01-search-ranking.md)** — query understanding → candidate retrieval (dense+sparse) → ranking → serving/logging. Applies: **no**. MerchGrid has no query surface and no learned relevance model — `Finding.severityRank` is a fixed rule-based ordinal, not a ranker trained on click data. The closest real hook: `Finding.searchText` already supports SQL `contains` search in `getScanFindings`.

- **[02-tech-support-chatbot.md](./02-tech-support-chatbot.md)** — intent classification → RAG over KB → LLM generation → escalation gate → agent-correction loop. Applies: **no**. Zero chat UI, zero LLM calls, zero escalation flow anywhere in the codebase — findings are reported, not conversed about. The closest real hook: each check's `explanation` text is already a hand-written, one-topic-per-check knowledge base, just never exposed through retrieval or chat.
