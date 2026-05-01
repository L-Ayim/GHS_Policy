# GPT Understanding Workflow

The GHS Policy app keeps GPT as the understanding layer. The backend does not decide policy meaning by itself. It exposes source access and write-back tools so GPT can build the corpus index document by document.

## Steward Tools

These tools are visible when `GHS_STEWARD_TOOLS=true`.

- `list_ununderstood_documents`: find documents with Tigris source files but no saved understanding.
- `fetch_document_source`: get a temporary signed Tigris URL for one PDF/DOCX source.
- `save_document_understanding`: write GPT-created document metadata, outline, navigation, chunks, citation spans, and quality notes.

Normal user-answer tools remain:

- `search`
- `fetch`
- `fetch_document_markdown`
- `corpus_stats`

## GPT Steward Loop

1. Call `list_ununderstood_documents`.
2. Pick one document, usually smaller files first.
3. Call `fetch_document_source`.
4. Read the source document.
5. Create:
   - concise summary
   - policy area
   - issuing body
   - effective year when knowable
   - audience
   - tags and aliases/acronyms
   - navigational outline
   - retrieval chunks
   - quality notes
6. Call `save_document_understanding`.
7. Repeat until `list_ununderstood_documents` returns no rows.

## Chunking Guidance

Chunks should be semantic, not arbitrary fixed windows.

Good chunk targets:

- one requirement/procedure/definition per chunk
- include heading context in `headingPath`
- keep enough surrounding text to answer a user question
- preserve table rows as readable text when tables matter
- include page/locator information when known

Typical size:

- 800-2500 words for policy sections
- shorter for forms/checklists
- longer only when splitting would destroy meaning

## Quality Flags

Set `quality.needsReview=true` when:

- the source is scanned or image-heavy and GPT could not read enough
- pages/sections seem missing
- a table is too complex to preserve
- document title/issuing body/year is uncertain
- the document is duplicate or mismatched

This keeps weak documents searchable but marks them for review before relying on them.
