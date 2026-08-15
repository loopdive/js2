---
id: 4448
title: "issue-3529-selector-preclaim: 4 tests red on main — 3 broken by 6203320a (prepare recursive class layouts), 1 born red in #4430; tests/issue-*.test.ts are not CI-gated"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [3529, 3520, 3522, 4430, 3341]
origin: "2026-08-15 dev-3518-standalone heads-up during the IR wave; provenance established by git bisect in the fable lane"
---

# #4448 — 4 red tests in `tests/issue-3529-selector-preclaim.test.ts` on main + the CI-gating gap that let them land

## Problem

`tests/issue-3529-selector-preclaim.test.ts` has 4 failing tests on current
`main` (verified 2026-08-15 at `f92a9aa6`: 4 failed | 62 passed). They were
first noticed during the IR wave (#4549) and initially attributed to it;
bisect proves the wave is NOT the cause — all four failures pre-date it.

### Provenance (measured, git bisect with a 4-vs-1 failure-count script)

1. **Born red (1 test):** `uses checker class-expression identity and keeps a
   conservative conditional fallback` — fails at `32af18f7` (2026-08-13, the
   merge of #4430 that INTRODUCED the test file). Expected reason
   `class-member-unsupported`, actual `body-shape-rejected`. The test entered
   the tree already failing.
2. **Broken by `6203320a`** — `feat(ir): prepare recursive class layouts`
   (2026-08-13 06:49, Codex-co-authored; touches `src/ir/program.ts`,
   `src/ir/backend/legality.ts`, `src/ir/nodes.ts` + 9 more). First bad
   commit for the other 3 tests (parent `c26670fd` fails only the born-red
   one):
   - `types 'class shape projection' before AST-to-IR build` — outcome object
     no longer matches the expected `kind: 'unsupported'` shape.
   - `does not inherit local-class identity through a 'parameter' shadow` —
     expected rejection reason `constructor-resolution-unsupported`, got
     `undefined` (the shadowed shape now claims, i.e. a potential
     over-claim, not just a reason drift).
   - `does not inherit local-class identity through a 'local variable'
     shadow` — same signature as the parameter-shadow case.

The two shadow cases are the concerning ones: `undefined` means the selector
no longer REJECTS a shape the test asserts must not claim (local-class
identity leaking through a shadowing binding). That is a claim-safety
question, not a diagnostics-labelling question, and it needs an answer from
the #3520/#3522 prepared-class model owners: either the new behavior is
correct (recursive class-layout preparation legitimately resolves these
shapes now → update the tests, with an argument why shadow inheritance is
sound) or it is an over-claim (→ fix `src/ir/program.ts`'s preparation
gates).

## The meta-problem: `tests/issue-*.test.ts` are not CI-gated

None of the six required checks runs the `tests/issue-*.test.ts` suite:
`equivalence-gate` runs `tests/equivalence/` only, `quality` runs
lint/ratchets, the test262 jobs run conformance, and `linear-tests` (not
required anyway) runs the linear subset. So a test file can be BORN red (as
#4430's was) or go red later (as `6203320a` did) with every gate green.
The failures above sat invisible for two days and were only found because a
wave agent ran the file incidentally.

## Acceptance criteria

1. For each of the 4 tests: a decision recorded here — behavior bug fixed,
   or test expectation updated with a stated soundness argument — and the
   file back to 66/66 green on main.
2. The two shadow cases specifically: an explicit statement whether
   local-class identity may be inherited through a parameter/local shadow
   under the prepared-class model, cited from the #3520/#3522 design.
3. A CI story for `tests/issue-*.test.ts`: either add the suite (or a
   sharded/changed-files subset) to a required check, or document in
   `docs/ci-policy.md` that these files are dev-local only and born-red
   files are accepted risk. Silent is the only wrong option.

## Verification commands

```bash
npx vitest run tests/issue-3529-selector-preclaim.test.ts   # 66/66 target
git bisect start dc7eb811 32af18f7                          # reproduces the provenance
```
