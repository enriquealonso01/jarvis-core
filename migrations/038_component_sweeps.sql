-- Nobody is watching the watchdog (plan II.3).
--
-- The watchdog's own failure is the one failure in this plan that gets QUIETER
-- instead of louder: a stopped watchdog produces exactly the console a calm
-- system produces - no stalls, no recoveries, no incidents - while tasks sit in
-- `running` forever. The evidence that it works is the absence of the events it
-- would have raised, which is no evidence at all.
--
-- So each COMPLETED sweep is recorded. Not a tick: liveness is not progress
-- applies to the watchdog exactly as it applies to a worker, and one wedged on
-- a database call would heartbeat perfectly.
CREATE TABLE IF NOT EXISTS component_sweeps (
  component          text PRIMARY KEY,
  -- Written after the sweep returns, never before.
  last_completed_at  timestamptz NOT NULL,
  -- Monotonic, so a reader can tell a running component from one that finished
  -- a sweep once and stopped.
  sweeps             bigint NOT NULL DEFAULT 0,
  -- Which process claims the work, so a restart is visible as a change of hand.
  owner              text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
