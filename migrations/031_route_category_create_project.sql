-- The router learned a sixth category and the table did not.
--
-- `create_project` was added to CATEGORIES so that "create a project called X"
-- stops being filed as something to remember. The CHECK constraint still listed
-- the original five plus 'mixed', so every create_project verdict failed to
-- persist — and the write is wrapped in `.catch(() => undefined)`, on the
-- reasoning that a routing record must never take a message down. Correct, and
-- it meant the failure was completely silent: the message routed fine, the
-- project was created, and `route_category` stayed null.
--
-- routing.ts opens by saying "Wrong routing is invisible otherwise, and the
-- documented way to find the bug is to read a day of verdicts". A verdict that
-- cannot be written is that sentence failing.

ALTER TABLE inbox_events DROP CONSTRAINT IF EXISTS inbox_events_route_category_check;
ALTER TABLE inbox_events ADD CONSTRAINT inbox_events_route_category_check
  CHECK (route_category = ANY (ARRAY[
    'capture', 'question', 'work', 'instruction', 'create_project', 'ambiguous', 'mixed'
  ]));
