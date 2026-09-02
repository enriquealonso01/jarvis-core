-- S18b: the recovery ladder writes its rungs onto the task's timeline.
--
-- `task_events.type` allowed six kinds and `recovery` was not one of them, so
-- every rung the ladder recorded was rejected by the CHECK constraint — and the
-- insert is deliberately wrapped in a catch (a timeline write must never break a
-- recovery), so it failed silently. The ladder then read back "nothing tried"
-- every time and repeated rung 1 forever, which is precisely the infinite loop
-- II.3 says a ladder without limits becomes.
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_type_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_type_check
  CHECK (type = ANY (ARRAY['tool','test','git','review','log','phase','recovery']));
