/**
 * `AGENTS.md` — the file S6 reads at every engineering task, and the file S26
 * writes at onboarding.
 *
 * Three decisions are baked in here, each of them a bug the plan names.
 *
 * **The template lives in code, not in `docs/`.** `docs/TEMPLATES.md` is the
 * human-readable copy and stays the document people edit, but the production
 * image copies `src`, `migrations` and `packages` and nothing else — reading the
 * doc at runtime would work in dev and fail on the box, which is exactly how the
 * console spent 21 hours serving a state nobody had published. `templateSync()`
 * exists so the two cannot drift silently: a test compares them.
 *
 * **A placeholder that survives rendering is a failure, not a default.** The
 * plan: "If `AGENTS.md` lands with template placeholders still in it, finalize
 * ran before every answer was collected — the onboarding session must refuse to
 * finalize on a missing required field rather than substituting a default."
 * `renderAgentsMd` therefore returns the missing field names instead of a file,
 * and there is no code path that fills one in.
 *
 * **The database row is canonical.** The plan again: "If the committed file and
 * the database disagree, decide which is canonical now and enforce it; two
 * sources of project policy is a bug that gets worse with time." The row in
 * `project_instructions_versions` is written first and is what Jarvis reads; the
 * committed file is a rendering of it, for the humans and agents working in the
 * repository. See ADR 018.
 */

/** Every `{{...}}` the template can carry, and what the onboarding calls it. */
export const AGENTS_FIELDS = [
  "project_name",
  "project_type",
  "production_status",
  "customer_facing",
  "confidentiality",
  "github_owner",
  "github_repo",
  "default_branch",
  "allowed_auth_profiles",
  "approved_data_processors",
  "setup_command",
  "test_command",
  "lint_command",
  "safe_environments",
  "deploy_policy",
  "project_forbidden",
  "before_pr",
  "before_deploy",
  "migration_policy",
  "default_queue_priority",
] as const;

export type AgentsField = (typeof AGENTS_FIELDS)[number];
export type AgentsAnswers = Partial<Record<AgentsField, string>>;

/**
 * The template. Kept byte-identical to the fenced block in `docs/TEMPLATES.md`
 * under "Project AGENTS.md (managed repos)" — see `templateSync`.
 */
export const AGENTS_TEMPLATE = `# Agent instructions — {{project_name}}

## Classification
- project_type: {{project_type}}
- production_status: {{production_status}}
- customer_facing: {{customer_facing}}
- confidentiality: {{confidentiality}}

## Repository
- owner/repo: {{github_owner}}/{{github_repo}}
- default_branch: {{default_branch}}
- credential: repository-specific only (never personal admin)

## Approved auth profiles
- {{allowed_auth_profiles}}
- Approved external data processors: {{approved_data_processors}}

## Commands
- Setup: {{setup_command}}
- Test: {{test_command}}
- Lint/type: {{lint_command}}

## Environments
- Safe: {{safe_environments}}
- Production deploy: {{deploy_policy}}

## Forbidden
- Cross-project files/secrets
- Weakening isolation/auth/backups
- {{project_forbidden}}

## PR / deploy gates
- Before PR: {{before_pr}}
- Before deploy: {{before_deploy}}
- Migrations: {{migration_policy}}

## Queue
- Default priority: {{default_queue_priority}}
`;

/** Every placeholder the template actually contains, in order of appearance. */
export function templatePlaceholders(template = AGENTS_TEMPLATE): string[] {
  return [...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]);
}

export type RenderResult =
  | { ok: true; body: string }
  | { ok: false; missing: string[] };

/**
 * Render, or say what is missing. Never both, and never a file with a hole in
 * it: a rendered `AGENTS.md` is a promise that every question was answered.
 *
 * An answer of `"none"` or `"n/a"` is a real answer — a project with no lint
 * command has answered the lint question. Only absence and whitespace count as
 * unanswered, because "he has not said yet" and "he said there is none" mean
 * opposite things to a step whose whole job is to stop guessing.
 */
export function renderAgentsMd(
  answers: AgentsAnswers,
  template = AGENTS_TEMPLATE,
): RenderResult {
  const needed = [...new Set(templatePlaceholders(template))];
  const missing = needed.filter((f) => {
    const v = answers[f as AgentsField];
    return typeof v !== "string" || v.trim() === "";
  });
  if (missing.length) return { ok: false, missing };

  const body = template.replace(/\{\{([a-z_]+)\}\}/g, (_m, field: string) =>
    (answers[field as AgentsField] as string).trim());

  /*
   * Belt and braces. If a substitution ever fails to fire — a placeholder with
   * an unexpected character, a template edited in a hurry — the caller must not
   * commit the result. Cheaper to check than to explain to a future agent why
   * its instructions contain a pair of braces.
   */
  const left = templatePlaceholders(body);
  if (left.length) return { ok: false, missing: left };

  return { ok: true, body };
}

/**
 * The doc and the constant above, side by side.
 *
 * `docs/TEMPLATES.md` is where a human reads the template and where the plan
 * points; the constant is what actually ships. Two copies of anything drift, so
 * this extracts the doc's fenced block and hands both back for a test to
 * compare. It is deliberately not called at runtime — the doc is not in the
 * image.
 */
export function templateFromDoc(doc: string): string | null {
  /*
   * Line endings are not content.
   *
   * The fence regex wants a newline after the fence marker, and a Windows
   * checkout hands this file over with CRLF because git converts on checkout.
   * So the match failed, this returned null, and S26 reported that the doc had
   * lost its AGENTS.md block - on a machine where the block was plainly still
   * there. The byte-identical comparison in that suite would have failed for
   * the same reason even if the fence had matched, since every line would
   * differ by a carriage return.
   *
   * Normalised here rather than in .gitattributes: the parser is what has to
   * be robust, and it should read the same file the same way on any machine.
   */
  const text = doc.replace(/\r\n/g, "\n");
  const section = text.split("## Project AGENTS.md (managed repos)")[1];
  if (!section) return null;
  const fence = section.match(/```markdown\n([\s\S]*?)```/);
  return fence ? fence[1] : null;
}
