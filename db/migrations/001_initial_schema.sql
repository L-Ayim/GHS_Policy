create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  visibility text not null default 'public',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  collection_id uuid not null references collections(id) on delete cascade,
  title text not null,
  slug text not null,
  source_kind text not null default 'local_file',
  source_path text not null,
  canonical_url text,
  mime_type text not null,
  status text not null default 'discovered',
  latest_revision_id uuid,
  policy_area text,
  issuing_body text,
  effective_year int,
  audience text[],
  tags text[] not null default '{}',
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (collection_id, source_path)
);

create table if not exists document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  revision_number int not null,
  storage_uri text,
  source_path text not null,
  checksum_sha256 text not null,
  file_size_bytes bigint not null,
  mime_type text not null,
  ingestion_status text not null default 'pending',
  extraction_status text not null default 'pending',
  chunking_status text not null default 'pending',
  embedding_status text not null default 'not_started',
  extraction_engine text,
  extraction_quality text,
  review_flag boolean not null default false,
  quality_notes text,
  page_count int,
  docling_job_id text,
  docling_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, revision_number),
  unique (document_id, checksum_sha256)
);

alter table documents
  add constraint documents_latest_revision_fk
  foreign key (latest_revision_id) references document_revisions(id)
  deferrable initially deferred;

create table if not exists document_sections (
  id uuid primary key default gen_random_uuid(),
  document_revision_id uuid not null references document_revisions(id) on delete cascade,
  parent_section_id uuid references document_sections(id) on delete cascade,
  section_path text not null,
  heading text,
  ordinal int not null,
  page_start int,
  page_end int,
  summary text,
  created_at timestamptz not null default now()
);

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  document_revision_id uuid not null references document_revisions(id) on delete cascade,
  section_id uuid references document_sections(id) on delete set null,
  chunk_index int not null,
  text text not null,
  token_count int,
  char_count int not null,
  page_start int,
  page_end int,
  paragraph_start int,
  paragraph_end int,
  line_start int,
  line_end int,
  heading_path text,
  content_kind text not null default 'body',
  search_text tsvector generated always as (
    to_tsvector('english', coalesce(heading_path, '') || ' ' || coalesce(text, ''))
  ) stored,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (document_revision_id, chunk_index)
);

create index if not exists chunks_search_text_idx on chunks using gin (search_text);
create index if not exists chunks_document_revision_idx on chunks(document_revision_id, chunk_index);
create index if not exists chunks_pages_idx on chunks(document_id, page_start, page_end);

create table if not exists citation_spans (
  id uuid primary key default gen_random_uuid(),
  chunk_id uuid not null references chunks(id) on delete cascade,
  start_char int not null default 0,
  end_char int not null,
  quoted_text text not null,
  page_start int,
  page_end int,
  paragraph_start int,
  paragraph_end int,
  line_start int,
  line_end int,
  locator jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  document_revision_id uuid not null references document_revisions(id) on delete cascade,
  job_type text not null default 'docling_extract',
  status text not null default 'queued',
  priority int not null default 100,
  attempt_count int not null default 0,
  worker_hint text,
  runpod_job_id text,
  input jsonb not null default '{}',
  output jsonb,
  last_error text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ingestion_jobs_status_idx on ingestion_jobs(status, priority, queued_at);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  collection_id uuid not null references collections(id) on delete cascade,
  external_conversation_id text,
  title text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists task_envelopes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete set null,
  collection_id uuid references collections(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  intent_type text not null,
  goal text not null,
  constraints jsonb not null default '{}',
  expected_output jsonb not null default '{}',
  source_scope jsonb not null default '{}',
  status text not null default 'created',
  trace_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists retrieval_traces (
  id uuid primary key default gen_random_uuid(),
  task_envelope_id uuid references task_envelopes(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  query_text text not null,
  retrieval_mode text not null default 'hybrid',
  threshold_passed boolean,
  answer_state text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists retrieval_candidates (
  id uuid primary key default gen_random_uuid(),
  retrieval_trace_id uuid not null references retrieval_traces(id) on delete cascade,
  chunk_id uuid not null references chunks(id) on delete cascade,
  dense_score double precision,
  lexical_score double precision,
  metadata_score double precision,
  hybrid_score double precision,
  rerank_score double precision,
  final_rank int not null,
  selected boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists answer_records (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  task_envelope_id uuid references task_envelopes(id) on delete set null,
  retrieval_trace_id uuid references retrieval_traces(id) on delete set null,
  state text not null,
  content text,
  model_name text,
  refusal_reason text,
  confidence double precision,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists answer_citations (
  id uuid primary key default gen_random_uuid(),
  answer_record_id uuid not null references answer_records(id) on delete cascade,
  citation_span_id uuid references citation_spans(id) on delete set null,
  chunk_id uuid references chunks(id) on delete set null,
  citation_order int not null,
  created_at timestamptz not null default now()
);

create table if not exists evidence_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_envelope_id uuid references task_envelopes(id) on delete set null,
  retrieval_trace_id uuid references retrieval_traces(id) on delete set null,
  source_type text not null default 'document_chunk',
  source_id uuid,
  locator jsonb not null default '{}',
  claim text,
  snippet text not null,
  freshness text,
  sensitivity text not null default 'public_policy',
  rights text not null default 'repository_supplied',
  confidence double precision,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into workspaces (slug, name, description)
values ('ghana-health-service', 'Ghana Health Service', 'Ghana Health Service policy corpus')
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description,
    updated_at = now();

insert into collections (workspace_id, slug, name, description, visibility)
select id, 'public-policy-corpus', 'Public Policy Corpus', 'Repository-supplied Ghana Health Service policy and guideline documents', 'public'
from workspaces
where slug = 'ghana-health-service'
on conflict (workspace_id, slug) do update
set name = excluded.name,
    description = excluded.description,
    visibility = excluded.visibility,
    updated_at = now();
