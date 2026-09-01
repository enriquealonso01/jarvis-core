"""
N1 — the acceptance test that matters (plan S8).

One seeded repository, one FAILING test, and the only question worth asking:
did Jarvis produce a change that turns it green?

The plan is blunt about how this test goes wrong: "If the test passes on a run
where the harness plainly did nothing, it is asserting the task row rather than
the diff." So nothing here reads task.state as evidence. The assertions are:

  1. the seeded test is RED before the run              (or the test proves nothing)
  2. a branch exists with commits the base does not have
  3. checking that branch out, the seeded test is GREEN
  4. the changed files include the SOURCE, not only the test
  5. a pull request was opened for it

Imported by scripts/acceptance-runner.py. Runs against the dev compose stack with
the fake harness by default — that is the CI mode — and against the real harness
when JARVIS_N1_HARNESS is set to something else.
"""
import json
import os
import re
import subprocess
import time
import uuid

COMPOSE = ["docker", "compose", "-f", "deploy/compose.dev.yaml"]
SLUG = "n1-acceptance"
HARNESS = os.environ.get("JARVIS_N1_HARNESS", "fake:fixtest")


def _run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def _sql(query: str) -> str:
    r = _run(COMPOSE + ["exec", "-T", "postgres", "psql", "-U", "jarvis", "-d",
                        "jarvis", "-tAX", "-c", query])
    return r.stdout.strip().replace("\r", "")


def _in_runner(script: str) -> str:
    """Run a shell snippet inside a runner container, which shares the volume."""
    r = _run(COMPOSE + ["run", "--rm", "--no-deps", "-T", "runner", "sh", "-c", script])
    return (r.stdout or "").replace("\r", "").strip()


SEED = r"""
set -e
SLUG=n1-acceptance
BARE=/var/lib/jarvis/dev-origins/$SLUG.git
WORK=/var/lib/jarvis/projects/$SLUG/repo
rm -rf "$BARE" /var/lib/jarvis/projects/$SLUG
mkdir -p /var/lib/jarvis/dev-origins /var/lib/jarvis/projects/$SLUG
git init --bare -q --initial-branch=main "$BARE"
T=$(mktemp -d)
git init -q --initial-branch=main "$T"
mkdir -p "$T/src" "$T/test"
cat > "$T/AGENTS.md" <<'MD'
# answerkit
## How to test
    node --test
MD
cat > "$T/package.json" <<'JSON'
{ "name": "answerkit", "version": "1.0.0", "type": "module", "private": true }
JSON
cat > "$T/src/answer.js" <<'JS'
export function answer() {
  return 41;
}
JS
cat > "$T/test/answer.test.js" <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { answer } from "../src/answer.js";

test("the answer is 42", () => {
  assert.equal(answer(), 42);
});
JS
git -C "$T" add -A
git -C "$T" -c user.email=s@j -c user.name=S commit -q -m "answerkit"
git -C "$T" push -q "$BARE" main
git clone -q "$BARE" "$WORK"
rm -rf "$T"
cd "$WORK" && node --test >/dev/null 2>&1 && echo GREEN || echo RED
"""


def run_n1(record, skip):
    """Execute N1 and record each assertion. `record(id, title, passed, detail)`."""
    started = time.time()

    # ---- seed, and prove the test is red to begin with -------------------
    out = _in_runner(SEED)
    initial = out.splitlines()[-1] if out else ""
    record("N1.1", "the seeded test is RED before Jarvis touches it",
           initial == "RED", f"node --test on main -> {initial or 'no output'}")
    if initial != "RED":
        skip("N1", "acceptance", "the seeded repo did not start red; nothing downstream would mean anything")
        return

    pid = _sql(
        "INSERT INTO projects (slug,name,project_type,confidentiality,default_branch) "
        f"VALUES ('{SLUG}','{SLUG}','personal','normal','main') "
        "ON CONFLICT (slug) DO UPDATE SET archived_at=NULL RETURNING id;"
    )
    pid = next((l for l in pid.splitlines() if re.fullmatch(r"[0-9a-f-]{36}", l)), "")
    tid = _sql(
        "INSERT INTO tasks (project_id,title,objective,state,lane,priority) VALUES "
        f"('{pid}','answer() returns the wrong number',"
        "'The test in test/answer.test.js fails: answer() returns 41 but should return 42. "
        "Fix the source so the test passes.','queued','heavy','high') RETURNING id;"
    )
    tid = next((l for l in tid.splitlines() if re.fullmatch(r"[0-9a-f-]{36}", l)), "")

    _run(COMPOSE + ["run", "--rm", "--no-deps", "-T",
                    "-e", "RUNNER_ONCE=1", "-e", "RUNNER_IDLE_EXIT_MS=8000",
                    "-e", f"JARVIS_HARNESS={HARNESS}",
                    "-e", "JARVIS_HEARTBEAT_MS=1500",
                    "-e", "JARVIS_SILENCE_LIMIT_MS=300000",
                    "runner"])

    branch = _sql(f"SELECT COALESCE(branch,'') FROM tasks WHERE id='{tid}';")

    # ---- the diff, not the task row --------------------------------------
    ahead = _in_runner(
        f"git -C /var/lib/jarvis/projects/{SLUG}/repo rev-list --count main..{branch} 2>/dev/null || echo 0"
    ) if branch else "0"
    record("N1.2", "a branch exists with commits main does not have",
           ahead.isdigit() and int(ahead) > 0, f"branch={branch or '(none)'} commits ahead={ahead}")

    changed = _in_runner(
        f"git -C /var/lib/jarvis/projects/{SLUG}/repo diff --name-only main..{branch}"
    ) if branch else ""
    files = [f for f in changed.splitlines() if f.strip()]
    record("N1.3", "the change touches the SOURCE, not only the test",
           any(f.startswith("src/") for f in files), f"changed: {', '.join(files) or '(nothing)'}")

    # ---- the seeded test, on the branch, from a clean checkout ------------
    verdict = _in_runner(
        "set -e; D=$(mktemp -d); "
        f"git clone -q --branch {branch} /var/lib/jarvis/projects/{SLUG}/repo $D >/dev/null 2>&1; "
        "cd $D && (node --test >/dev/null 2>&1 && echo GREEN || echo RED); rm -rf $D"
    ) if branch else "RED"
    verdict = verdict.splitlines()[-1] if verdict else "RED"
    record("N1.4", "the seeded test is GREEN on Jarvis's branch",
           verdict == "GREEN", f"clean clone of {branch or '(none)'} -> node --test -> {verdict}")

    # ---- the pull request -------------------------------------------------
    pr = _sql(f"SELECT COALESCE(pr_url,'') FROM tasks WHERE id='{tid}';")
    reason = _sql(f"SELECT COALESCE(waiting_reason,'') FROM tasks WHERE id='{tid}';")
    record("N1.5", "a pull request was opened for it",
           pr.startswith("http"),
           pr if pr else f"no PR. reason: {reason[:160] or '(none recorded)'}")

    print(f"    N1 finished in {time.time() - started:.0f}s using harness {HARNESS}")
