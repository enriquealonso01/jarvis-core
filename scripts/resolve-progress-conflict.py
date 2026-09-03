"""
Resolve a PROGRESS.json merge conflict by keeping the longer evidence.

PROGRESS.json is one long evidence string per step, appended to by every tick,
so two branches that both recorded findings conflict on the same line every
time. Both sides are almost always the same text with a different tail, and the
merge is "keep the side that knows more" - which is the longer string, since
evidence is only ever appended.

Written down as a script rather than done by hand each time because doing it by
hand is how a tick's findings get dropped: the conflict markers sit inside a
2000-character line and the wrong side looks identical at a glance.

    python scripts/resolve-progress-conflict.py PROGRESS.json
"""
import datetime
import json
import re
import sys


def resolve(text: str) -> tuple[str, int]:
    pattern = re.compile(
        r"<<<<<<< [^\n]*\n(?P<ours>.*?)\n?=======\n(?P<theirs>.*?)>>>>>>> [^\n]*\n",
        re.S,
    )

    def pick(m: "re.Match[str]") -> str:
        ours, theirs = m.group("ours"), m.group("theirs")
        keep = ours if len(ours) >= len(theirs) else theirs
        return keep if keep.endswith("\n") else keep + "\n"

    return pattern.sub(pick, text), len(pattern.findall(text))


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "PROGRESS.json"
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    resolved, count = resolve(text)
    if "<<<<<<<" in resolved:
        print("unresolved markers remain; not writing")
        return 1

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    resolved = re.sub(r'"updated_at": "[^"]*"', f'"updated_at": "{now}"', resolved, count=1)

    # Parse before writing: a resolution that produces invalid JSON must fail
    # here, not when the console next tries to render the build bar.
    data = json.loads(resolved)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"resolved {count} hunk(s); {len(data['steps'])} steps; updated_at {now}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
