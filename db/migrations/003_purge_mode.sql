-- 003_purge_mode.sql — make the append-only trigger purge-aware for demo reset ONLY.
--
-- need_events / audit_log stay append-only in ALL normal operation. The demo reset
-- (src/demo/reset.ts) opens one transaction, does `SET LOCAL relay.allow_purge = 'on'`
-- (scoped to that transaction — it dies on COMMIT/ROLLBACK, never leaks to another
-- session), then DELETEs the is_demo rows. This replaces the function by name, so the
-- existing need_events_append_only / audit_log_append_only triggers pick it up.
-- Without the flag, every UPDATE/DELETE still raises — the invariant is intact.

create or replace function relay_forbid_mutation () returns trigger as $$
begin
  if current_setting('relay.allow_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;
