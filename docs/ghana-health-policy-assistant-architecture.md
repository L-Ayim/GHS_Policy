# Ghana Health Policy Assistant Architecture

## Product Intent

Build a Ghana Health Service policy assistant that lets ChatGPT answer questions from the policy, guideline, SOP, survey, and ethics-review documents in this repository.

The assistant should behave like Awal for document-grounded answers and like Y-MIR/Anchor for the ChatGPT-facing control plane:

- documents are the source of truth
- retrieval happens before answer generation
- answers carry citations to documents, pages, and spans
- unsupported questions get a refusal or a request for narrower scope
- every answer has a trace that can be audited
- ChatGPT gets a small, stable tool surface instead of direct access to internals

The current corpus is `docs/`, with 133 PDFs and 8 DOCX files at the time this note was written.

## Reference Lessons

### From Awal

Awal is the closest implementation reference for the core Q&A loop.

Reuse these ideas:

- workspace and collection boundaries
- document and document-revision records
- ingestion jobs instead of request-path parsing
- chunks and citation spans tied to a specific revision
- hybrid retrieval over lexical, metadata, and optional embeddings
- explicit answer states: `grounded_answer`, `insufficient_evidence`, `conflict_detected`, `ingestion_pending`
- answer citations stored from selected evidence, not guessed after generation

Do not let the model answer from general knowledge when the user asks about Ghana Health Service policy.

### From Y-MIR/OA

Y-MIR/OA is the reference for making this usable from ChatGPT as a governed runtime.

Reuse these ideas:

- authenticated ChatGPT-facing tool surface
- entitlement and access checks around protected records
- task envelopes for user intent
- evidence artifacts for retrieved support
- audit events for reads, answers, exports, and future writes
- durable workspace records for uploaded/generated artifacts
- thin session guidance that tells ChatGPT when and how to call the backend

The Ghana assistant should expose policy search and policy Q&A to ChatGPT, while the backend owns source scope, retrieval, citation formatting, refusal policy, and logging.

### From Anchor

Anchor gives the larger system discipline.

Use this framing:

- Ghana policy corpus is a `SourceGateway`
- each retrieved span is an `EvidenceArtifact`
- each user question becomes a `TaskEnvelope`
- policy answer generation is a contract-bound read operation
- future document edits, sharing, or publication flows must use preview, approval, execution, verification, and audit

For v1, keep the system read-only.

## V1 User Experience

The user should be able to ask:

- "What does the GHS code of conduct say about disciplinary procedures?"
- "What are the requirements for ethical review of an online survey?"
- "Compare the malaria drug policy and treatment guideline on first-line treatment."
- "Which policies mention transport management?"
- "Give me the source pages for the answer."

The assistant should return:

- direct answer
- source document titles
- page or span references when available
- confidence or answer state
- refusal when the evidence is missing or weak

## V1 Tool Surface For ChatGPT

Keep the public MCP/API surface narrow:

- `ghs.bootstrap_session`
  - returns active corpus scope, available capabilities, and answer rules
- `ghs.search_policies`
  - searches document metadata and indexed chunks
- `ghs.ask_policy`
  - asks a grounded question over the permitted corpus
- `ghs.get_sources`
  - returns citations, snippets, and document/page locators for an answer
- `ghs.list_documents`
  - lists available documents and ingestion status

The model should not directly choose embedding queries, chunk windows, thresholds, or reranking internals. Those stay in the runtime.

## Core Data Model

Start with these tables or equivalent persistence objects:

- `workspaces`
- `collections`
- `documents`
- `document_revisions`
- `document_sections`
- `chunks`
- `citation_spans`
- `conversations`
- `messages`
- `retrieval_traces`
- `retrieval_candidates`
- `answer_records`
- `answer_citations`
- `task_envelopes`
- `evidence_artifacts`
- `audit_events`

Document identity should be stable. Revision identity should change when a file changes or is reprocessed.

## Ingestion Pipeline

V1 ingestion should:

1. scan `docs/`
2. compute checksums and metadata
3. extract text from PDF and DOCX
4. preserve page information where available
5. segment into sections and chunks
6. create citation spans
7. create document summaries and keywords
8. create lexical search index
9. optionally create embeddings and rerank indexes
10. mark extraction quality and review flags

Documents with weak extraction, scanned pages, broken text order, or no page mapping should be flagged for review instead of silently treated as high confidence.

## Answer Policy

`ghs.ask_policy` should return one of:

- `grounded_answer`
- `insufficient_evidence`
- `conflict_detected`
- `ingestion_pending`
- `out_of_scope`

The answer generator may synthesize across retrieved evidence, but it must not invent missing policy details. If documents conflict, the answer should show the conflict and cite both sides.

## Recommended First Build Slice

1. Scaffold a Next.js app in this repo.
2. Add document registry and local SQLite or Postgres persistence.
3. Add a local ingestion script for the existing `docs/` folder.
4. Implement lexical retrieval first.
5. Add `ask_policy` with evidence-bound answer states.
6. Add source citations and a simple chat UI.
7. Add MCP-compatible tool endpoints for ChatGPT.
8. Add embeddings and reranking after lexical retrieval is working.

This gets the useful thing working before adding multi-tenant billing, advanced workspace views, or write operations.

## Non-Negotiables

- Cite the source document for every substantive answer.
- Preserve page references where extraction allows it.
- Refuse instead of guessing.
- Do not mix users, workspaces, or collections when auth is added.
- Store retrieval traces so bad answers can be debugged.
- Keep the ChatGPT-facing tool surface small.
- Treat the Ghana Health Service corpus as institutional source material, not background context.
