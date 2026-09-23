---
id: 3444
title: "negative_test_fail residual (v8 harvest): early-error not detected + negative test mis-passes — 89 default / 45 standalone"
status: in-progress
created: 2026-07-19
updated: 2026-09-13
priority: medium
task_type: bug
area: test262-conformance
goal: test262-conformance
model: fable
sprint: current
related: [3417, 3026, 721, 418, 2920]
---

# #3444 — negative_test_fail residual (v8 harvest, 2026-07-19)

## Active slice: arrow lexical NewTarget environment (2026-09-13, Codex)

This slice does not close the residual issue. The historical implementation
plan below predates the existing `src/compiler/early-errors` AST validation
pass and must not be followed as a proposal to create a second walker.

### Ownership and starting evidence

- Start at verified upstream main
  `3e92241ecc3ee81df38df29cdd228537364bd19b`, in the isolated worktree on
  `codex/3444-newtarget-arrow-20260913`.
- The pre-dispatch check found no open PR mentioning this issue, no issue-file
  match in a complete open-PR scan, and no held parent or slice claim. The
  unrelated historical GitHub PR numbered 3444 is not an implementation of
  this markdown issue. Claim `3444:newtarget-arrow` is verified on the upstream
  assignment registry for `ttraenkler/codex-3444-newtarget-arrow`.
- The fresh standalone baseline JSONL, SHA-256
  `728d1aebe31b432ffa208da78dd6113c735182d92aec5576fa04f6512e627e3f`,
  still reports `test/language/global-code/new.target-arrow.js` as
  `negative_test_fail`: expected SyntaxError but compiled with no diagnostic.
  It belongs to the exact 11,704-file official ES2015 manifest. A fresh local
  reproduction is still required before implementation; source inspection
  alone is not runtime or maintained-runner acceptance evidence.
- The candidate is confined to `src/compiler/early-errors/predicates.ts`,
  `src/compiler/early-errors/node-checks.ts`, and focused early-error tests.
  Do not edit codegen context/declarations/index/allocation, IR preparation,
  native body extraction, migration receipts, or any other session's worktree.
  Expand this boundary only after coordination with the lead and the owner.

### Implementation plan

1. Reproduce the unchanged Test262 negative through the maintained standalone
   runner on the starting head, with a passing positive control. Inspect its
   raw-source parse-negative path; do not change the runner or suppress a
   diagnostic to manufacture a pass.
2. Add focused red coverage for global `new.target` inside one or more arrows.
   Verify positive lexical inheritance in ordinary functions, function
   expressions, methods, accessors, and constructors. Include computed-name
   versus function-body boundaries and preserve valid class field/static-block
   behavior where the existing parser supports it; derive those cases from
   language semantics and a real engine control rather than AST ancestry alone.
3. Introduce a dedicated, grammar-aware NewTarget-environment predicate for
   the existing MetaProperty check. Arrows inherit an outer environment but do
   not create one. Do not change the generic `isInsideFunction` predicate used
   by return/yield or broad function-scope checks. Preserve `import.meta` and
   other unrelated validation behavior.
4. Re-run focused positive/negative coverage and unchanged Test262 originals
   through the maintained runner, retaining exact counts, full exit metadata,
   source head, and durable worktree-local logs. Run relevant existing
   early-error/MetaProperty suites, TS7 typecheck, and normal repository hooks.
   A successful early-error unit test is not a full-suite pass claim.
5. Update this issue with the implementation, measured evidence, and remaining
   residual work. Use Thomas Tränkler as author with the actual Codex model
   trailer and co-author. Push the completed fix to `ttraenkler/js2` and open
   one ready upstream `loopdive/js2` PR when mergeable; use draft only if the
   checkpoint is not ready to merge. Use the standard Description, Validation,
   and checked CLA body sections, with a separate peer shepherd.

Implementation is assigned to Terra Max in the isolated worktree. All compiler
tests and git hooks share one team lease alongside the existing ES2015 census;
capture terminal statuses and never kill a test without user permission.

### Implementation handoff (2026-09-13, in progress)

- On starting head `3e92241ecc3ee81df38df29cdd228537364bd19b`, the authoritative
  isolated standalone runner (`scripts/run-test262-paths.mts`, which delegates
  to `runTest262File`) recorded the unchanged pair as `1 pass, 1 fail out of 2`:
  `language/global-code/new.target-arrow.js` failed with `Test262: This
  statement should not be evaluated.`, while the paired
  `language/global-code/new.target.js` control passed. The terminal log is
  `.tmp/3444-starting-original-control-elevated.log`.
- The scoped change adds `hasNewTargetEnvironment` to the existing early-error
  predicates and routes only the `new.target` MetaProperty check through it.
  Arrows remain lexical; non-arrow functions contribute only their body and
  parameter subtrees, while computed member names continue out to their outer
  context. Class field initializers and class static blocks remain valid
  NewTarget environments. `isInsideFunction` and all unrelated MetaProperty
  rules, including `import.meta`, remain unchanged.
- Focused red evidence before the predicate was `8 failed / 10 passed` (18)
  in `.tmp/3444-focused-red.log`. The expanded Node-parser + isolated
  early-error matrix is now `23 / 23` passing in
  `.tmp/3444-focused-expanded.log`; it covers global arrows, parameter/body
  inheritance, computed method/getter/setter boundaries, getter/setter bodies,
  instance/static field initializers, and static blocks.
- After the source fix, the same authoritative isolated standalone pair is
  `2 / 2` passing (`.tmp/3444-original-control-postfix.log`), so the original
  parse-negative is counted as a Test262 pass rather than a raw compile or
  runtime outcome.
- Adjacent early-error/MetaProperty suites `issue-1931`, `issue-2898`,
  `issue-3026`, `issue-927-safe`, `issue-1315`, and `issue-1512` passed
  together (121 passing tests). Their combined command also included
  `issue-189`, whose one runtime failure is not claimed as a regression:
  exact isolated A/B runs on the untouched starting head and this candidate
  both ended `1 failed / 3 passed` with the identical missing
  `env::__get_undefined` LinkError. Baseline and candidate logs are retained at
  `/private/tmp/js2-3444-starting-20260913/.tmp/3444-issue-189-baseline.log`
  and `.tmp/3444-issue-189-candidate.log` respectively.
- Final TS7 typecheck passed (`.tmp/3444-ts7-typecheck-final.log`), and scoped
  Prettier plus `git diff --check` passed. The normal commit hook also passed
  lint-staged (Prettier and Biome), LOC/function budgets, the changed-root
  `23 / 23` test, and the oracle ratchet. Push and PR publication remain
  pending; this slice does not close #3444.
- Worktree dependency note: the repository provisioning script made `test262/`
  a 26-entry symlink farm, but lint-staged could not traverse that directory
  while Git tracked `test262` as a symlink. The intact farm is preserved at
  `.tmp/3444-test262-farm-preserved`; the live dependency is a single visible,
  unstaged symlink to `/Users/thomas/Code/js2/test262`. `HEAD:test262` remains
  the original `/home/user/js2/test262` blob and is not staged. A detached
  baseline-only `skip-worktree` experiment established that the warning was
  local layout noise; it is not used in this candidate or its committed tree
  and will be cleared after publication. No hook-created stash is removed.

### Acceptance / handoff

- [x] Fresh original failure and passing control reproduced on the starting head.
- [x] Global-arrow `new.target` rejects with the expected early SyntaxError.
- [x] Valid lexical NewTarget contexts remain accepted; unrelated rules unchanged.
- [x] Original/control maintained-runner verdicts and focused controls are current.
- [ ] Required checks pass and one correctly formatted upstream PR is published.

## Summary

Per the harvest protocol (inspect `negative_test_fail` — real conformance bugs,
not noise), the 2026-07-19 baselines show a standing negative-test residual that
has **no open tracker** — the prior trackers (#3026, #721, #418, #2920) are all
`status: done`. #3417 explicitly flagged `fail::negative_test_fail` (88) as
"REAL conformance bugs — needs sub-bucket triage". This issue is that tracker.

Negative tests either (a) should raise an **early/parse SyntaxError** but the
compiler accepts the code with no diagnostic, or (b) should throw at **runtime**
but execution succeeds.

## Sub-buckets (both lanes, official)

| signature | default | standalone |
| --- | ---: | ---: |
| `expected SyntaxError but compiled with no diagnostic (early error not detected)` | 44 | — |
| `expected resolution SyntaxError but compiled with no diagnostic` (module instantiation) | 22 | 22 |
| `expected runtime ReferenceError but succeeded` | 12 | 12 |
| `expected runtime Test262Error but succeeded` | 6 | 6 |
| `expected runtime SyntaxError but succeeded` | 3 | 3 |
| `expected runtime TypeError but succeeded` | 2 | 2 |
| **total** | **89** | **45** |

## Sample paths

- `test/language/statements/labeled/value-await-module.js` (early SyntaxError not detected)
- `test/language/module-code/import-attributes/import-attribute-newlines.js` (resolution SyntaxError)
- `test/language/statements/switch/scope-lex-class.js` (runtime ReferenceError not thrown — lexical scope / TDZ)

## Root cause (hypothesis)

The compiler's early-error / static-semantics pass under-enforces several
grammar-level restrictions (labeled `await` in module context, duplicate
import-attribute keys, lexical-declaration scope collisions), and some runtime
TDZ / ReferenceError paths resolve the binding instead of throwing. The v8
harness runs the real negative-test verdict, exposing these.

## Suggested fix

Sub-triage by the specific early-error rule (each is a small static-semantics
check). Start with the `early error not detected` cluster (44) since it is the
largest and purely a parse-time validation gap. Cross-check the done #418 /
#3026 fixes for which rules regressed vs newly-surfaced under v8.

## Regression note

Prior negative-test trackers closed at earlier baselines; this residual is the
current v8-baseline standing surface with no open owner. Low-to-medium count but
genuine conformance bugs.

## Implementation Plan (architect, 2026-07-19 — mechanism sites verified)

### Where early errors are enforced today (read before changing anything)

The compiler has TWO early-error levers, both diagnostic-code-driven — there is
NO custom static-semantics AST walk today:

1. `ES_EARLY_ERROR_CODES` (`src/checker/index.ts:406-419`) — TS diagnostic
   codes NOT suppressed even under `skipSemanticDiagnostics` (1100, 1102/1103,
   1210/1211, 1213/1214, 1359/1360, 2300, 2480, 18050).
2. `HARD_TS_DIAG_CODES` (`src/compiler.ts:93-109`) — semantic TS codes promoted
   to hard compile errors (1213/1214 reserved-word-in-strict, #1435).
   The gate that turns these into a failed compile is
   `src/compiler.ts:1368-1379` (`hasSyntaxErrors || hasHardTypeErrors`).

The residual exists because several ES early-error rules have **no TS
diagnostic at all** (TS is more permissive than the ES grammar) — so no code
list can catch them. Those need a small dedicated walk.

### Changes (per sub-bucket)

**Sub-bucket 1 — `early error not detected` (44, largest)**
- Sample `language/statements/labeled/value-await-module.js`: `await: 1` as a
  LABEL in module code must be a SyntaxError (`await` is reserved in module
  goal). TS accepts it (it only restricts `await` as an *identifier
  expression* in modules).
- Add a `collectEsEarlyErrors(sourceFile, { isModule, isStrict })` syntactic
  walker in a new `src/checker/early-errors.ts`, invoked next to the
  syntactic-diagnostics collection feeding `src/compiler.ts:1373`; its findings
  join `errors` and set the same `hasSyntaxErrors` gate so `negative.phase:
  parse` verdicts see a failed compile.
- Rules to implement first (pull the exact list by bucketing the 44 sample
  paths from the harvest jsonl before coding — do NOT guess): labeled
  `await`/`yield` (module / generator context), and whichever 2-3 rules
  dominate the remaining samples.

**Sub-bucket 2 — module `resolution SyntaxError` (22+22, both lanes)**
- Sample `import-attributes/import-attribute-newlines.js` family: duplicate
  attribute keys / grammar restrictions on import attributes. Same walker,
  module-goal rules (ImportAttributes: duplicate keys → SyntaxError).

**Sub-bucket 3 — runtime `ReferenceError`/`TypeError`/`SyntaxError` not thrown (12/6/3/2)**
- Sample `statements/switch/scope-lex-class.js` — TDZ/lexical-scope semantics,
  NOT parse-time. These are codegen bugs (binding resolves where the spec
  requires a throw). Triage separately; if the TDZ cluster is coherent, split
  it into its own issue rather than bolting runtime fixes onto this
  parse-focused one. `expected runtime Test262Error but succeeded` (6) usually
  means an assertion path was optimized away — check against the #3285
  weakened-assertion class before treating as codegen.

### Edge cases
- The walker must be **goal-sensitive**: script vs module vs strict-mode
  function bodies (the compiler's module detection feeds `isModule`).
- Never fire on valid TS-only syntax (type annotations, enums) — walk the
  ORIGINAL parse tree only for constructs that are pure JS grammar.
- Verify no false positives across the existing equivalence suite —
  early-error over-enforcement fails positive tests, which is worse than the
  44 misses.

### How to test
- Negative fixtures: the 3 sample paths above via `runTest262File` — verdicts
  must flip to pass (compile fails with a diagnostic, which the negative-test
  protocol counts as the expected SyntaxError).
- Positive control: `tests/equivalence.test.ts` green; a labeled statement
  named `await` in SCRIPT (non-module, non-async) code must still compile.
- Both lanes benefit (parse-time is lane-independent) — the 45-standalone
  column should drop in lockstep.
