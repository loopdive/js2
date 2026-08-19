---
id: 4448
title: "issue-3529-selector-preclaim: 4 tests red on main — 3 broken by 6203320a (prepare recursive class layouts), 1 born red in #4430; tests/issue-*.test.ts are not CI-gated"
status: done
completed: 2026-08-15
assignee: ttraenkler/opus-4448
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [3529, 3520, 3522, 4430, 3341]
loc-budget-allow:
  # +27 lines in the file that OWNS the shadow predicate: the over-claim fix has
  # to record which binding the walk bound, next to where it binds it.
  - src/ir/select.ts
func-budget-allow:
  # +3 / +1 lines: the class-binding record must be written exactly where these
  # two walkers bind the name, and a per-subject reset where they reset state.
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/select.ts::whyNotIrClaimable
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

## Resolution (2026-08-15)

Reproduced at `92f78620`: **4 failed | 62 passed**. Final state: **67 passed
(67)** — the count moved from 66 because one stale rejection case was replaced
by two sharper tests (below), not because a test was deleted to go green.

### AC 2 — the two shadow cases: an OVER-CLAIM, fixed in the selector

**Statement: local-class identity may NOT be inherited through a parameter or
local-variable shadow.** The prepared-class model (#3520/#3522) keys a class on
its *declaration* identity (`IrClassId` derives from the declaration site), not
on its text; `localClassValueIsUnshadowed` was the one place that decided the
question by NAME, and it got it wrong.

Root cause is **not** `6203320a` (that commit does not touch `src/ir/select.ts`;
the bisect landed on it because both commits are in the same day's IR wave).
The real change is **`19902d67` "feat(ir): prepare bounded nested class
components"**, which loosened the shadow predicate to admit a *nested* class
declaration's own binding:

```ts
// 19902d67 (over-broad — matches on TEXT)
const exactNestedClassBinding = scope.has(name) && currentLocalClassDeclarations.get(name)?.name !== undefined;
```

`currentLocalClassDeclarations` is unit-wide, so a **parameter** or **local
variable** whose text happens to equal a projected class's name satisfied it and
the `new Box(1)` arm read the outer class's constructor identity.

**Probe (`.tmp/probe-shadow-runtime.ts`, compile + instantiate + run, four
shapes) — the claim was not merely mislabelled, it produced a wrong answer:**

| shape | node | wasm BEFORE fix | wasm AFTER fix |
| --- | --- | --- | --- |
| `function test(Box: number) { new Box(1); return 1 }` | throws `TypeError: Box is not a constructor` | **returned 1** | throws |
| same, result observed (`return value.value`) | throws `TypeError` | **returned 1** | throws |
| `const Box = 1; new Box(1); return 1` | throws `TypeError` | **returned 1** | throws |
| same, result observed | throws `TypeError` | **returned 1** | throws |

IR outcome before: `emitted/patch` (claimed). After: `unsupported/select/
constructor-resolution-unsupported`, and the legacy path traps — matching JS's
throw. So the test's expectation was right and the behavior was wrong.

**Fix** (`src/ir/select.ts`): track *which binding* the walk bound, instead of
matching text. A new per-subject `currentPreparedClassBindingNames` is populated
at exactly the two places that introduce a prepared class binding — the nested
`class` declaration statement arm and the `const C = class {…}` vardecl arm —
and `localClassValueIsUnshadowed` consults that set. It is branch-scoped in
`withProjectionEvidenceScope`, so a class bound inside one `if` arm is not
visible to a sibling arm that binds the same text as a plain value. #3522's
nested-class ownership tests stay green (both nested-class files pass), which is
the coverage the loosening existed for.

### AC 1 — per-test decisions

| test | decision |
| --- | --- |
| `does not inherit local-class identity through a 'parameter' shadow` | **behavior bug fixed** (above) |
| `does not inherit local-class identity through a 'local variable' shadow` | **behavior bug fixed** (above) |
| `types 'class shape projection' before AST-to-IR build` | **expectation updated — the case is genuinely supported now.** `6203320a` preallocates the shape cell for a self-recursive class, so `class Builder { add(v): Builder { return new Builder(this.value + v) } }` is claimed and emitted. Not relabelled: the case moved to a new test that **executes** the module and asserts `test() === 3`, which matches node. (Direct selection without checker shapes still reports `class-projection-unsupported`; the compile path with projected shapes emits it.) `class-projection-unsupported` keeps its coverage in the four `rejects an unrepresentable class $name` cases, the missing-projection test, and the `instanceof` test. |
| `uses checker class-expression identity and keeps a conservative conditional fallback` (born red in #4430) | **expectation was written against a source that never reaches the seam.** `const boxes = [new Box()]` is rejected by the vardecl arm first — reason `body-shape-rejected`, detail `vardecl-init-expr:ArrayLiteralExpression` — **identically with and without** `resolveLocalClassExpression`, and identically with a plain field instead of the computed getter. So `body-shape-rejected` is the correct classification and the array literal, not the member, is what decides. The test now uses a `Box[]` **parameter**, which does reach the seam: with the seam it yields the originally-expected `class-member-unsupported`, without it there is no rejection at all — so the reason is attributable to the seam. The array-literal behavior is pinned in its own new test, including the plain-member control. |

### AC 3 — CI story: a new NON-required `issue-tests` job (option (a))

`.github/workflows/ci.yml` gains `issue-tests` (+
`scripts/select-changed-issue-tests.mjs`), split in two steps:

* **pinned (fatal)** — a short curated list, currently just
  `tests/issue-3529-selector-preclaim.test.ts`, verified green on main. A
  failure there is a real regression. **Measured 45 s** of vitest on the 4-core
  dev box (job cap 20 min).
* **changed (advisory, `continue-on-error`)** — every `tests/issue-*.test.ts`
  the PR touches, capped at 15 files.

The split is deliberate. The suite is **not clean on main**: a small sample
during this issue found **8 further pre-existing failures**, verified
pre-existing by A/B against the unmodified `src/ir/select.ts` —
`issue-3522-ir-class-compile-once` (2: constructor receiver accessors on the
direct dispatch path, gc + standalone lanes), `issue-3529-dataflow-outcomes`
(3), `issue-3529-integration-preflight` (3). A red **non-required** check drives
`mergeStateStatus` to `UNSTABLE`, which `auto-enqueue` skips outright
(#3878/#3904), so making the changed-files step fatal would strand PRs behind
tests that were already red. Grow the pinned list as files are verified green;
promote the job to required once the suite is clean. Documented in
`docs/ci-policy.md` §"Optional / informational checks".

### Gates run

`tests/issue-3529-selector-preclaim.test.ts` 67/67 · `check:ir-fallbacks` OK, no
bucket delta · `typecheck` clean · `lint` clean · `format:check` clean ·
equivalence shards 1/8 and 4/8 "no new regressions" (shard 4 reports one
baseline entry now passing — verified pre-existing on the unmodified base, so
not attributable here and the baseline was left alone) · `#3522` nested-class
ownership and `#3520` class-shape identity files green.
