-- 002_dedupe.sql — dedupe signals on the needs projection row.
-- Idempotent (safe to re-run forward-only). The vector + pg_trgm extensions are
-- created in 001; the embedding column (vector(1536)) already exists there too.
-- Beneficiary PII never lands here: contact_hash is a keyed HMAC blind index of the
-- number (src/lib/contactHash.ts), and dedupe_text is a PII-free derived signal.

alter table needs add column if not exists contact_hash text;
alter table needs add column if not exists dedupe_text text;

-- Exact-contact match: partial b-tree over the blind index (only rows that carry one).
create index if not exists idx_needs_contact_hash on needs (contact_hash) where contact_hash is not null;

-- Fuzzy same-incident match: trigram similarity over the derived text, used as the
-- fallback signal when no embedding is present.
create index if not exists idx_needs_dedupe_text_trgm on needs using gin (dedupe_text gin_trgm_ops);
