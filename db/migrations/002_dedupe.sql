-- 002_dedupe.sql — dedupe signals on the needs projection row.
-- Idempotent (safe to re-run forward-only). pg_trgm is created in 001 (always available);
-- the embedding column (vector(1536)) is created in 001 ONLY when pgvector is present, so
-- everything here is pgvector-independent and applies cleanly on a plain Postgres.
-- Beneficiary PII never lands here: contact_hash is a keyed HMAC blind index of the
-- number (src/lib/contactHash.ts), and dedupe_text is a PII-free derived signal.

alter table needs add column if not exists contact_hash text;
alter table needs add column if not exists dedupe_text text;

-- Exact-contact match: partial b-tree over the blind index (only rows that carry one).
create index if not exists idx_needs_contact_hash on needs (contact_hash) where contact_hash is not null;

-- Fuzzy same-incident match: trigram similarity over the derived text, used as the
-- fallback signal when no embedding is present. Unconditional — pg_trgm is always here.
-- (No vector/embedding index lives in this file; the sole ANN index is guarded in 001.)
create index if not exists idx_needs_dedupe_text_trgm on needs using gin (dedupe_text gin_trgm_ops);
