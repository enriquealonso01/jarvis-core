# The private benchmark

Real bugs from this codebase, with known-good fixes. The plan is explicit that
the cases must be real: *"A private benchmark built from issues already solved in
these repos — real bugs with known-good fixes"*, and *"If every candidate scores
the same, the cases are too easy. Add cases from bugs that actually took real
time to solve."*

Each case is a directory:

    case.json     what the agent is told, and what a correct fix touches
    seed/         the repository state the agent starts from, bug included
    hidden/       tests the agent never sees, run against whatever it produced

The split between `seed/` and `hidden/` is the whole design. An agent that
writes a test asserting its own behaviour passes its own suite; `hidden/` is what
decides whether the bug is actually gone. `scoreRun` weights it three times
anything else for that reason.

## Adding a case

Take a bug that cost real time, and that has a fix you can state in one
assertion. Put the code as it was BEFORE the fix in `seed/`, and a test that
fails against it in `hidden/`. Then check the case is not too easy: if a case is
solved by every engine on the first attempt it separates nothing, and belongs in
the regression suite rather than here.

Cases are deliberately small. The benchmark measures engineering judgement on a
known bug, not the ability to navigate a large repository — that is what the real
projects measure, every day, for free.
