# ADR 019 — Postgres full-text search before embeddings

- **Status:** accepted
- **Date:** 2026-09-03
- **Step:** S30 (memory and knowledge)

## Context

S30 has to answer *"somewhere where I can just dump stuff, and it will organize
it. I will be able to ask questions about anything at any time."* The instinct
for that sentence is a vector store.

The plan asks for an ADR before the step and states the recommendation as its
starting position rather than an open question. This records the decision and,
more usefully, what would overturn it.

## Decision

`knowledge_chunks` with a `tsvector` column, a GIN index, content-aware
chunking, ranked with `ts_rank_cd`, scoped by `project_id` with a global tier.
Embeddings are added only when retrieval is measured to be insufficient without
them.

## Why, on this machine specifically

Three reasons, and none of them is "embeddings are bad":

- **Postgres is already here.** Already running, already backed up, already
  restored by the drill, already inside the isolation model. A separate vector
  store is a second thing to back up, secure, scope per project and restore.
  `docs/GAP_ANALYSIS.md` exists because v1 built infrastructure ahead of need.
- **ADR 007 gives embeddings 1024 MB and forbids them while heavy work is
  active.** A tier that can only run when the box is idle is a poor foundation
  for "at any time". The retrieval path has to work at 3pm on a Tuesday with a
  heavy run going.
- **Most real queries here are lexical.** The corpus is one person's documents
  and chat history, and the questions are names, clients, projects, error
  strings. `tsvector` with good chunking answers those well, and answers them
  the same way twice.

## What this does not claim

It does not claim lexical search is as good as semantic search at semantic
questions. It will lose on paraphrase - *"the thing about refunds"* against a
document that says "chargeback window" - and that is a real limitation, not a
detail.

The bet is narrower: that chunking quality dominates retrieval quality at this
corpus size, and that the money is better spent there first. The plan says the
same thing in its own words, and it is testable rather than a matter of taste.

## What would overturn it

A measured miss rate on real questions that chunking cannot fix. Concretely: a
set of questions Enrique actually asks, run against the corpus, where the right
chunk exists and lexical ranking does not surface it. If that set is large and
the misses are paraphrase-shaped, embeddings earn their MB.

Until that measurement exists, adding a vector store would be building
infrastructure ahead of need, which is the specific mistake this project has
already made once and written a document about.

## Consequences

- Retrieval is available whenever Postgres is, including during heavy runs.
- Chunking carries the quality burden, so it is built first and tested first —
  `src/chunk.ts` and `scripts/s30-chunk-test.sh` exist before any ranking code.
- Every chunk keeps its kind, its date and its position from the start, even
  though nothing reads them yet: S41 needs a time index, and a chunk stored
  without a usable date gives it nothing to search on.
- If embeddings arrive later they sit beside this rather than replacing it, and
  the comparison will be against a measured baseline rather than an assumption.
