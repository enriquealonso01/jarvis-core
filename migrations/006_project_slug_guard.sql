-- The project slug is used to build filesystem paths
-- (/var/lib/jarvis/worktrees/<slug>), and it arrives from a model tool call or
-- an API body. Nothing constrained its shape, so `../../..` was a legal slug.
--
-- Application code validates it now; this is defence in depth so a future call
-- site cannot reintroduce the hole.
ALTER TABLE projects
  ADD CONSTRAINT projects_slug_shape
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$');
