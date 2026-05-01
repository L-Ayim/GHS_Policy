alter table document_revisions
  add column if not exists understanding_status text not null default 'not_started',
  add column if not exists understanding_engine text,
  add column if not exists understanding_payload jsonb,
  add column if not exists understanding_completed_at timestamptz;

create index if not exists document_revisions_understanding_status_idx
  on document_revisions(understanding_status, updated_at);

create table if not exists document_understanding_runs (
  id uuid primary key default gen_random_uuid(),
  document_revision_id uuid not null references document_revisions(id) on delete cascade,
  status text not null default 'created',
  actor text not null default 'gpt_app',
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists document_understanding_runs_revision_idx
  on document_understanding_runs(document_revision_id, created_at desc);
