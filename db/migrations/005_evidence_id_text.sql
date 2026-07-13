-- 005 · need_events.evidence_id should be TEXT, not UUID.
--
-- EvidenceAttached events carry `evidence_id` = an evidence *reference* — a Slack file id
-- (e.g. "F0123ABC"), a short note, or a demo sentinel. None of those are UUIDs. The original
-- `uuid` column rejected every real photo reference with `invalid input syntax for type uuid`
-- (22P02), which aborted the append and broke the evidence → Verified → Closed flow (both the
-- live `/relay demo` hero arc and a real coordinator attaching a photo). The mismatch slipped
-- past tests because the in-memory store performs no UUID validation.
--
-- Widen to text (a superset of uuid): existing values cast losslessly, there is no index or FK
-- on the column, and the projection only ever reads `evidence_id` from the jsonb payload — never
-- as a uuid. ALTER COLUMN TYPE is DDL, so the append-only row trigger does not fire.
alter table need_events
  alter column evidence_id type text using evidence_id::text;
