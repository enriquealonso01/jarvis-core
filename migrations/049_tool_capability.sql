-- S31: the Connections tab shows a CAPABILITY, not a tool name.
--
-- The plan's line, and the reason it matters: at call time all you have is a
-- name, and `update_record` tells you nothing about whether the record is in a
-- staging database or a customer's billing account. A tab listing
-- `update_record`, `list_items`, `send` has told a reader nothing they can act
-- on - which is the same failure as a citation that says "somewhere in this
-- PDF".
--
-- So the person classifying writes down what the tool actually lets Jarvis do,
-- in their own words, at the moment they are deciding its blast radius. That is
-- the only moment anybody has the evidence in front of them, and it is the
-- same moment the plan already requires a human to be present for.
--
-- Deliberately NOT defaulted from the tool's name or its description. The name
-- is what the tab must stop showing, and the description is written by the
-- thing being gated - a capability derived from either would be the server
-- describing its own blast radius.
ALTER TABLE connection_tools
  ADD COLUMN IF NOT EXISTS capability text;
