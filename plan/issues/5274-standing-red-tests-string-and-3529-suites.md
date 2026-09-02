---
id: 5274
title: "17 tests across 5 string/#3529 suites are red on main and invisible to CI"
status: done
sprint: current
created: 2026-09-02
updated: 2026-09-02
completed: 2026-09-02
priority: high
horizon: s
complexity: S
feasibility: easy
reasoning_effort: medium
task_type: test-fix
area: tests, ci
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r6
---

# 17 tests across 5 string/#3529 suites are red on main and invisible to CI

## Problem

Measured on `origin/main` `351f2bfc6b` (2026-09-02, before the F2-S3 lane's
first edit — recorded in the #3526 F2-S3 checkpoint note, probe P4) and
re-confirmed on `3ba791164e`: **17 tests fail across 5 files** with no change
in the working tree:

| file | red | what they pin |
| --- | --- | --- |
| `tests/issue-320.test.ts` | 1 | "handles programs with no dead imports (no-op)" — WAT now carries `string_constants."add"` / `""` module-init globals |
| `tests/imported-string-constants.test.ts` | 4 | string-constant import surface |
| `tests/issue-3529-equivalence-error-imports.test.ts` | 8 | error-path import surface |
| `tests/issue-3529-dataflow-outcomes.test.ts` | 2 | "records unary `!` coercion as unsupported" (now `emitted@patch` after #4512 `!ref` ToBoolean, `from-ast.ts:12378-12384`) and the paired invariant |
| `tests/issue-3529-ir-producer-parity.test.ts` | 2 | "preserves inferred boolean identity across an externref console boundary"; "types array-literal widening" (extra `<module-init>` outcome row) |

These are stale pins, not compiler defects: each froze a routing/import fact
that a later landed slice (#4512 ToBoolean, the module-init outcome rows of
#3523 gap 4, the string-constant global registration) deliberately changed.
The same class as #5259 (`issue-3517-map-module-init` rot, 5/14 red).

## Why CI never caught it

Same three conditions as #5259: the only job running `tests/issue-*.test.ts`
is not a required check (`issue-tests`, `.github/workflows/ci.yml:713-740`),
its pinned list (`scripts/select-changed-issue-tests.mjs:39-68`) covers none of
these five files (only `issue-3529-selector-preclaim` of the 3529 family), and
its changed-files step (`:741-745`) is advisory. Two IR-migration lanes in one
day (#3526 F2-S1/S3) each had to re-measure this red on base to keep their own
non-vacuity counts honest.

## Acceptance criteria

1. All five files green on main (`npx vitest run` on each), 17/17 fixed.
2. Each stale pin is **rewritten to assert the current truthful behavior**,
   not deleted, with a one-line comment citing the slice that changed the fact
   (#4512, #3523 gap 4, the string-constant registration change) — the #5259
   standard.
3. The fixed files' assertions are checked against the intent of the original
   issue (#320, #3529) so a real regression in that area would still be caught.
4. A note in this issue records whether the `issue-tests` job would have
   surfaced any of the 17 on a recent PR run (one run link), feeding the
   separate CI-gate decision that #5259 already asks for. Changing the gate
   design is OUT of scope here.

## Context

- Found by the #3526 F2-S3 implementation lane while establishing its
  revert-non-vacuity baseline (checkpoint note, probe P4: "17 failing tests
  across 5 files, not 4"); the F2-S3 PR (#5448) deliberately did not touch them.
- Together with #5259 this is the second standing red found in one session by
  lanes that measure base before editing; a required, changed-files-driven
  issue-tests gate would make both classes impossible to accumulate.

## 2026-09-02 checkpoint note — Opus lane

Branch `claude/issue-5274-string-test-rot`, base `origin/main` `7f998ff873`.

### Measured before-state (untouched base, `npx vitest run <file>` per file)

`7f998ff873`, one file per invocation. **17 failures, matching the issue exactly** —
1 + 4 + 8 + 2 + 2:

| file | result | failing test → message |
| --- | --- | --- |
| `tests/issue-320.test.ts` | 1 failed / 7 passed (8) | "handles programs with no dead imports (no-op)" → `expected '(module\n  (import "string_constants"…' not to contain '(import'` |
| `tests/imported-string-constants.test.ts` | 4 failed / 17 passed (21) | "multiple distinct string literals produce multiple global imports" → `expected 5 to be 3`; "no string_constants section when source has no string literals" → `expected 2 to be +0`; "string array literal access works" → `LinkError: Import #5 module="env" function="__get_undefined": function import requires a callable`; "module with no strings needs no string_constants import" → `TypeError: Import #0 module="string_constants": module is not an object or function` |
| `tests/issue-3529-equivalence-error-imports.test.ts` | 8 failed / 1 passed (9) | all eight `provides the production <E> constructor for manual instantiation` rows (Error, TypeError, RangeError, SyntaxError, URIError, EvalError, ReferenceError, AggregateError) → `expected [ { module: 'env', …(4) } ] to deep equally contain { module: 'env', …(3) }` at `:47` |
| `tests/issue-3529-dataflow-outcomes.test.ts` | 2 failed / 21 passed (23) | "records unary ! coercion as unsupported" → got `{kind:"emitted", stage:"patch", irBodyEmitted:true, legacyBodyEmitted:false}`; "keeps unary ! with a checker-boolean carrier contradiction invariant" → `expected undefined to be an instance of Error` |
| `tests/issue-3529-ir-producer-parity.test.ts` | 2 failed / 1 passed (3) | "preserves inferred boolean identity across an externref console boundary" → got `{kind:"unsupported", irBodyEmitted:false}`; "types array-literal widening as an unsupported representation" → extra `<module-init>` `non-executable` row |

**After:** all five files green — `Test Files 5 passed (5)`, `Tests 64 passed (64)`.

### The 17 rewrites and their citations

Every citation was found by `git log -S` / `git bisect` on the **unshallowed**
clone (the session's clone was shallow to 2026-08-26, which hides every one of
these commits — worth knowing for the next lane that tries this).

1–3. **`.name` metadata now interns string constants** — `8d17e2d8e0`
   *feat: add function/class .name property infrastructure (#731)*, 2026-03-25.
   `collectFunctionClassNames` (`src/codegen/declarations/import-collector.ts:1455-1495`)
   pre-registers every function/class name, and `finalizeUnifiedCollector:1647`
   adds the implicit `""` once the pool is non-empty. Confirmed by stack-trace
   probe: `export function add(a,b){…}` yields pool `["add",""]` and two
   `string_constants` global imports.
   - `issue-320` "handles programs with no dead imports (no-op)": the #320 intent
     is *dead-import elimination*, so it now pins that directly — no
     `wasm:js-string` import, no `env` import, and the surviving import list is
     exactly the two `.name` globals.
   - `imported-string-constants` "multiple distinct string literals…": keeps the
     three `toContain` literal checks and pins the exact sorted pool
     `["", "bar", "baz", "foo", "test"]` instead of `length === 3`.
   - `imported-string-constants` "no string_constants section…": pins the pool to
     exactly `["", "add"]` — i.e. **no user literal is interned**, the claim that
     was actually worth keeping — plus the `.name` import that now exists.

4. **`imported-string-constants` "module with no strings needs no
   string_constants import"** — same #731 fact from the instantiation side. Now
   asserts `result.imports` is empty (no `env` import needed) and supplies only
   `string_constants` built from the pool.

5. **`imported-string-constants` "string array literal access works"** —
   `56d1211acc` *fix(#2773): S7 — externref plain-array OOB reads undefined;
   length-bounded vec reads; grow-write gap-fill*, 2026-07-09. Verified clean at
   its parent (`RESULT NONE`) and dirty at it (`RESULT HAS`): `days[1]` now pulls
   `env.__get_undefined` plus `__box_number`/`__unbox_number`, none of which the
   file's hand-rolled `env` stub supplied. The `run()` helper now routes through
   `instantiateWithRuntime` (the production runtime import builder) so it tracks
   the current host surface instead of re-pinning a 2026-03 snapshot.

6–13. **The eight Error-family rows** — `a41115bc78` *perf(#4150): kill
   per-crossing arg-array allocation in host imports*, 2026-08-04, added
   `paramCount` to every `ImportDescriptor`, so the exact-shape `toContainEqual`
   at `:47` stopped matching. Rewritten to pin the arity too (`1`, and `3` for
   `AggregateError`) rather than relaxing to a partial match — #4150 made the ABI
   width load-bearing, so it belongs in the assertion.

14–15. **The two unary-`!` dataflow pins** — `c171454d11` *feat(#4512): ref-typed
   ToBoolean in condition/ternary/! position*.
   - "records unary ! coercion as unsupported": the `!` row is split out of the
     `+`/`-` table (which still demotes correctly) into its own test asserting the
     measured `{kind:"emitted", stage:"patch", legacyBodyEmitted:false,
     irBodyEmitted:true}` plus both policy verdicts — a silent fall back to the
     legacy body would still fail it.
   - "keeps unary ! … contradiction invariant": ToBoolean now *converts* a
     mismatched carrier instead of throwing, so the `!`/boolean/F64 row is split
     out and asserts lowering succeeds. The `+`/`-` rows keep asserting
     `invariant`. A `lowerWithCallees` helper was factored out for this.

16. **producer-parity "preserves inferred boolean identity…"** — `100543f4e7`
    *refactor(#4514): directional reverse-callers edge restores compile-once for
    ABI-certified callees*, 2026-08-16 (git-bisected over 10,052 commits;
    parent good, commit bad). The untyped `isEven`/`isOdd` pair now demotes at IR
    **selection** with `operand-coercion-unsupported`, cascading
    `call-graph-closure` onto `<module-init>`. See the criterion-3 note below.

17. **producer-parity "types array-literal widening…"** — `22a72e500a`
    *feat(3523): record a truthful non-executable module-init outcome row*,
    2026-08-31 (R4 gap 4). A source with an empty module-init population is no
    longer silent, so the ledger carries a second row. The exhaustive `toEqual`
    is **kept** (the point of the pin is that `test` is the only unit that
    demotes) and the new row added, rather than relaxing to containment.

### Criterion 3 — intent check against #320 and #3529

Every rewrite was checked against the originating issue's intent; **none was
weakened to a superset**, and no assertion was deleted.

- **#320 (dead-import elimination):** strictly *stronger*. The old
  `not.toContain("(import")` was a blunt any-import check; the rewrite pins the
  exact surviving import list, so a regressed `wasm:js-string` or `env` import —
  the actual #320 failure mode — still fails, and now so does an unexpected
  *extra* string-constant global.
- **String-pool intent:** the two `length`-based pins became exact sorted-pool
  equalities. A literal that stops being interned, or one that starts being
  interned spuriously, still fails. `toBe(3)` would not have caught the latter.
- **#3529 P5 (Error-family import surface):** unchanged in kind and now pins
  arity as well. The e2e half of each row (constructor identity, `errors`/`cause`
  ABI, instantiation, `test()` returning 1) was never red and is untouched.
- **#3529 P2 (dataflow outcomes):** splitting the `!` case is what *preserves*
  the intent — the surviving `+`/`-` rows still pin the demote and the invariant
  respectively, and `!` gains a positive pin on its new lowering. Collapsing the
  tables to something both cases satisfy is what would have lost the gate.
- **#3529 producer parity, item 16 — the one place worth flagging.** The claim
  this test is named for, boolean identity across the externref boundary, is
  **still true and still asserted**: `expect(result.wat).toContain("__box_boolean")`
  passes unchanged. What moved is the *routing*, so the outcome pin is now the
  truthful demote, with `legacyBodyEmitted: true` retained (nothing emitted at all
  still fails) and the two callee rows added so the cascade is pinned at its
  source rather than only at `<module-init>`. **This is an IR-coverage narrowing,
  not a semantic regression** — the program compiles and boxes correctly via the
  legacy body. It is nonetheless a real capability loss for the untyped
  mutual-recursion shape under #4514 and deserves its own issue against the
  ir-full-coverage goal; it is out of scope here, where the mandate is pins, not
  compiler behaviour. Recorded rather than papered over.

### Criterion 4 — would `issue-tests` have surfaced any of the 17?

**No — zero of the 17, and four of the five files are structurally unreachable.**

Evidence: run <https://github.com/loopdive/js2/actions/runs/33580595431>, job
`issue-tests` <https://github.com/loopdive/js2/actions/runs/33580595431/job/100094026969>
(PR head `cecb06f989`, `perf(codegen): skip module-init pass 2 …` (#3523 gap-1b),
2026-09-02T01:46Z, conclusion **success**). The job ran exactly two files:

- *pinned (fatal)* — `tests/issue-3529-selector-preclaim.test.ts`, the sole entry
  of `PINNED` in `scripts/select-changed-issue-tests.mjs:39-45`;
- *changed (advisory)* — `tests/issue-3523-module-init-single-pass.test.ts`
  (log: `select-changed-issue-tests: base=3ba791164e changed=1 running=1`).

Neither is one of the five. Three structural reasons, all still true:

1. `imported-string-constants.test.ts` can **never** be selected — the selector's
   `ISSUE_TEST` regex is `^tests/issue-[^/]*\.test\.ts$` and the filename does not
   match, so no change to any file could make this job run it.
2. The other four match the regex but are not pinned, so they run **only** when the
   PR itself touches them — which is exactly the case that cannot exist for a
   standing red nobody is editing.
3. The changed-files step is `continue-on-error: true` (`ci.yml:741-745`), and
   `issue-tests` is not a required check, so even a hit would not have blocked.

Per the issue, gate redesign is out of scope; this row feeds the decision #5259
already asks for.

### Deviations

- The clone was **shallow** to `362b8297` (2026-08-26); `git fetch --unshallow`
  was required before any citation could be found. Not a scope change, but it is
  the reason this took a full-history fetch.
- Two throwaway worktrees under `.claude/worktrees/` were used for the bisects and
  removed afterwards (`git worktree list` clean).
- Nothing under `src/**`, `scripts/*-baseline.json`, or any test file outside the
  five was modified. `tests/equivalence/helpers.ts` is *imported* by the rewritten
  `run()` helper, not edited.
