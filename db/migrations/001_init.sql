-- 001_init.sql — Relay core schema.
-- Source of truth = need_events (append-only). Everything else is projection or registry.
-- On RDS: run as master user so CREATE EXTENSION succeeds.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Transport-level Slack event dedupe (Slack retries deliveries; business-level
-- idempotency_key on need_events is the second layer).
create table if not exists slack_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

create table if not exists channel_configs (
  channel_id text primary key,
  role text not null check (role in ('intake', 'dispatch', 'volunteers', 'hq', 'judges')),
  is_demo boolean not null default false
);

create table if not exists localities (
  id serial primary key,
  name text not null unique,
  aliases text[] not null default '{}',
  lat double precision not null,
  lng double precision not null,
  is_demo boolean not null default false
);

create table if not exists needs (
  id uuid primary key default gen_random_uuid(),
  public_id text unique not null,               -- N-0421
  status text not null default 'NEW',           -- PROJECTION ONLY; only the projector writes this
  type text not null,
  severity text not null,
  locality_id int references localities (id),
  location_text text,
  people_count int,
  languages text[] not null default '{}',
  source_permalink text,
  confidence jsonb not null default '{}',       -- per-field stated|inferred|unknown
  dedupe_cluster uuid,
  embedding vector (1536),                      -- text-embedding-3-small; null when pg_trgm fallback
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists need_events (
  seq bigserial primary key,
  need_id uuid not null references needs (id),
  type text not null,
  actor_type text not null check (actor_type in ('human', 'agent', 'system')),
  actor_id text,
  payload jsonb not null default '{}',
  evidence_id uuid,
  idempotency_key text not null unique,
  ts timestamptz not null default now()
);
create index if not exists idx_need_events_need on need_events (need_id, seq);

-- Append-only, enforced in the database itself — not just convention.
create or replace function relay_forbid_mutation () returns trigger as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;

drop trigger if exists need_events_append_only on need_events;
create trigger need_events_append_only
  before update or delete on need_events
  for each row execute function relay_forbid_mutation ();

create table if not exists volunteers (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text unique not null,
  display_name text not null,
  skills text[] not null default '{}',
  languages text[] not null default '{}',
  home_locality int references localities (id),
  radius_km int not null default 5,
  capacity_per_day int not null default 2,
  availability jsonb not null default '{}',
  active_load int not null default 0,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists obligations (
  id uuid primary key default gen_random_uuid(),
  need_id uuid not null references needs (id),
  volunteer_id uuid not null references volunteers (id),
  status text not null,                          -- projection from need_events
  sla_due_at timestamptz,
  delays_count int not null default 0,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references obligations (id),
  kind text not null check (kind in ('photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff')),
  slack_file_id text,
  meta jsonb not null default '{}',
  is_demo boolean not null default false,
  ts timestamptz not null default now()
);

-- Beneficiary PII lives ONLY here, AES-256-GCM encrypted at the application layer.
-- Reads happen via the reveal button, which writes an audit_log row.
create table if not exists contact_vault (
  need_id uuid primary key references needs (id),
  encrypted_payload bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists sitreps (
  id uuid primary key default gen_random_uuid(),
  stats jsonb not null,
  narrative text not null,
  canvas_id text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  seq bigserial primary key,
  actor_id text not null,
  action text not null,
  subject text not null,
  meta jsonb not null default '{}',
  ts timestamptz not null default now()
);

drop trigger if exists audit_log_append_only on audit_log;
create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function relay_forbid_mutation ();
