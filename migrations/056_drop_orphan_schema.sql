-- Remove schema that reached production from branches that were never merged.
--
-- Authorized in coordination/BLOCKERS.md B11 (CLEARED 2026-09-03).
--
-- `deploy-core.sh` packs the working tree, so deploying from a branch applied
-- that branch's migrations permanently: the box carried 50 applied migrations
-- against 46 in main. `connection_actions` and `mcp_tools` came from
-- feat/s31-connector-interface, which was never merged; main took a different
-- design (`ALTER TABLE connections ADD permitted_actions`), so nothing in main
-- creates or references either table. Both are empty and nothing points at
-- them, so this is a drop with no data loss and no dependents.
DROP TABLE IF EXISTS connection_actions;
DROP TABLE IF EXISTS mcp_tools;

-- Their schema_migrations rows go too: the files exist in no branch, so leaving
-- the rows records the application of something nobody can read.
DELETE FROM schema_migrations
 WHERE version IN ('041_connection_actions.sql', '042_mcp_tools.sql');

-- 044_outbox_handed_off and 045_outbox_dropped are DELIBERATELY LEFT ALONE,
-- though B11 lists them, because they are not orphans in the same sense.
--
-- They widened notifications_outbox_state_check to allow 'handed_off' and
-- 'dropped', that constraint is still in force, and TWO ROWS currently hold
-- 'handed_off'. Deleting their schema_migrations rows would erase the only
-- record of why the constraint permits those states, and reverting the
-- constraint would fail against the rows that use it. Removing a record of
-- schema that really exists is not cleanup; it is losing the provenance of a
-- thing while leaving the thing.
--
-- Those two rows are a separate problem, reported rather than silently fixed:
-- they are WhatsApp notifications parked in a state no code in main writes or
-- reads, so they will never send and never retry. One of them says "[outbox]
-- whatsapp did not confirm delivery".
