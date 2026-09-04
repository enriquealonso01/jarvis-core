-- S46, "parking releases the lane" - enforced by the table rather than by
-- everyone remembering.
--
-- A lease OWNER says "this process is attached to this task and nobody else may
-- claim it". Nine call sites released it by passing `lease_until = NULL` into
-- transitionTask's extraSet and leaving `lease_owner` set, which is worse than
-- forgetting both: reconcileExpiredLeases finds abandoned leases by looking for
-- an expiry in the past, so nulling the expiry and keeping the owner put the row
-- permanently beyond the reach of the only thing that would have cleaned it up.
--
-- The dev database was carrying 88 such rows - succeeded (34), waiting_for_user
-- (25), failed_terminal (13), waiting_for_provider (12), stalled (4) - against
-- ONE genuinely running task. `lanesInUse` counts owners, so every seat count
-- the system reported was fiction, including the one S46's own suite asserts on.
--
-- WHY A TRIGGER AND NOT ONLY A CHECK. A bare CHECK was written first and it was
-- wrong in a way worth recording: a statement that forgets to release the seat
-- then FAILS, and the statement that forgets is the one finishing the work. The
-- dev stack showed it immediately - a task whose harness had run cleanly ended
-- at `worker.crash`, still `running`, because the UPDATE that would have marked
-- it `succeeded` was rejected. A leaked lease is bookkeeping; a lost run is
-- work. Rejecting the write trades a small wrong for a larger one.
--
-- So the trigger REPAIRS instead. The invariant becomes unrepresentable rather
-- than merely forbidden, no caller can write the lie whatever it says, and no
-- statement fails. The CHECK stays underneath as the assertion that the repair
-- actually happened - a BEFORE trigger runs first, so it can only fire if the
-- trigger is dropped or wrong.
--
-- `lease_until` is deliberately NOT part of the rule. Without an owner it is not
-- a claim about a worker, it is the recovery ladder's cooling-off period: the
-- claim query holds back a queued task whose lease_until is still in the future,
-- and that is the only scheduler a rung's backoff has.

-- 1. The rows already lying. Only the lease is touched; the task's own state and
--    history are the part that was true.
UPDATE tasks
   SET lease_owner = NULL, updated_at = now()
 WHERE lease_owner IS NOT NULL
   AND state NOT IN ('preparing', 'running', 'waiting_for_tool', 'recovering');

-- 2. And expiries that have already passed on those rows, which hold nothing
--    back and only make the row harder to read. A future one is a live backoff
--    and is left alone.
UPDATE tasks
   SET lease_until = NULL
 WHERE lease_until IS NOT NULL AND lease_until < now()
   AND state NOT IN ('preparing', 'running', 'waiting_for_tool', 'recovering');

-- 3. The repair. An allow-list: a state added to the machine later holds no
--    lease until somebody adds it here on purpose.
CREATE OR REPLACE FUNCTION tasks_release_lease_on_leaving() RETURNS trigger AS $$
BEGIN
  IF NEW.state NOT IN ('preparing', 'running', 'waiting_for_tool', 'recovering') THEN
    NEW.lease_owner := NULL;
    -- A future expiry is a backoff and survives; one already past is noise.
    IF NEW.lease_until IS NOT NULL AND NEW.lease_until <= now() THEN
      NEW.lease_until := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_release_lease_on_leaving ON tasks;
CREATE TRIGGER tasks_release_lease_on_leaving
  BEFORE INSERT OR UPDATE OF state, lease_owner ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_release_lease_on_leaving();

-- 4. And the assertion that it worked. Unreachable while the trigger is in
--    place, which is the point: it fails only if somebody removes the repair.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_lease_only_while_working
  CHECK (
    lease_owner IS NULL
    OR state IN ('preparing', 'running', 'waiting_for_tool', 'recovering')
  );
