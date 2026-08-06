# W6 — dynamic-scope residue (2026-08-06): context + PR body

Agent `ttraenkler/W6-dynamic-scope`. Issue **#4179** (claimed on
`origin/issue-assignments`), branch `issue-4179-toplevel-with-module-init`.
Lever: `.tmp/levers/W5-dynamic-scope.txt` — 308 ES5-label standalone failures.

## PR body (verbatim)

Closes #4179. Measured **1 → 41 of 308** on the dynamic-scope standalone lever
list; **+35 net** (45 fixes / 10 vacuous-pass conversions, itemized below) on
the full 391-file with-exposure population.

### Root cause — the lever's framing was wrong (third refutation on this ground)

The 30 `S11.13.2_A5.*_T2/_T3` residuals were handed off as a "module-scope
struct-slot vs sidecar observability gap (#2659 family)". Measured: **the
`with` body never executed at all.** `collectDeclarations`' module-init
collection (`src/codegen/declarations.ts` ~1598) is an allow-list of statement
kinds and `ts.WithStatement` was not in it — a top-level `with (o) { … }`
matched no arm and was silently dropped from `__module_init`. Disassembly
receipt: a module whose statements were `var sB2 = mk(); with (sB2 || null)
{ x = 55; }` compiled to a `__module_init` containing exactly one instruction
(`global.set (call $mk)`).

Same family as #2992 (top-level `delete`), #3592 (top-level `throw`), #3615
(top-level bare property read). The with-lowering itself (#1387 / #3025 W1 /
#2663 Tiers 1-2 + RMW) was never at fault — the identical code inside a
function body passed.

### Fix

Two arms in `src/codegen/declarations.ts`:
- `ts.isWithStatement(stmt)` in the module-init collection allow-list;
- `walkModuleStmtForVars` recursion into the with body (`with (o) { var v; }`
  hoists `v` to module scope).

Byte-identical for any module without a top-level `with`.

### Measurement

Harness: L4's validated in-process runner (`runTest262File`, standalone lane)
with the #4162 `js2wasm:runtime-eval` provider shim; provider **rebuilt from
current main** before the baseline (the cached one predated today's six PRs).
Baseline reproduced the published histogram before any change.

| run | pass | delta |
| --- | ---: | ---: |
| lever list (308), main `176e…`/`5b12…` | 1 | — |
| lever list (308), fixed | **41** | **+40** |

Bucket flips: both `scope.x === 6. Actual: NaN` / `innerScope.x` buckets
(15+15) → pass; `with` requires-closed-shape refusals grew 12 → 29
(previously-dropped statements now honestly reach the Tier-2
nested-function-boundary refusal — all were already failing).

Exposure-population regression sweep — every test262 file containing a `with (`
statement (382 line-start + 9 mid-line extras), both builds run locally on the
same provider binary:

| population | main (A) | fixed (B) | net |
| --- | ---: | ---: | ---: |
| 382-file exposure | 115 | **150** | **+35** |
| 9 mid-line extras | 4 | 4 | 0 (no flips) |

45 files pass→, **10 pass→fail — every one a VACUOUS PASS converting to an
honest verdict** (the with body never ran before, so the test's assertions
never executed):

- 5 → compile_error (the pre-existing Tier-2 nested-function-boundary refusal
  now reached): `has-property-err`, `unscopables-get-err`,
  `unscopables-prop-get-err`, `S12.10_A3.8_T3`, `S12.10_A1.8_T3`.
- 3 → fail: `built-ins/Proxy/has/*-using-with` (standalone Proxy gap, body now
  actually exercises it).
- 2 → fail: `binding-not-blocked-by-unscopables-{falsey-prop,non-obj}`
  (@@unscopables edge in the Tier-2 gate, now actually exercised).

This is the same accepted trade as #3615 ("a test whose entire point is
'reading this property must throw/observe' ran to completion and scored
pass"). Net on the exposure population is +35; the merge_group net guard sees
a strictly positive delta.

Gates: `tsc --noEmit` clean; `check:oracle-ratchet` / `check:coercion-sites`
clean; `check:loc-budget` / `check:func-budget` green via `loc-budget-allow` /
`func-budget-allow` on #4179 (the allow-list IS `collectDeclarations`; +2
predicates cannot live in a subsystem module). `tests/issue-4179-toplevel-with.test.ts`
5/5; `tests/issue-2663-with-rmw.test.ts` 10/10; the 5 failures in
`tests/issue-2663.test.ts`/`issue-1387*` are pre-existing — verified identical
with main's `declarations.ts` swapped in.

## State / next steps

- `tests/issue-4179-toplevel-with.test.ts` — 5 cases (Tier-1 static, Tier-2
  dynamic, the `_A5` RMW reference-once shape, var-hoisting, JS-host lane).
- `tests/issue-2663*.test.ts` / `issue-1387*`: 5 failures pre-existing,
  verified identical with main's `declarations.ts` swapped in.

## Remaining lever buckets (post-fix, 41/308), sharpest-first

- **11× `null pointer in __str_concat (via __module_init)`** (`S12.10_A3.*`):
  NOT part of the #4179 drop — these tests wrap the `with` in a top-level
  `try`, and nested withs were always compiled (`compileStatement` handles
  them; only DIRECT top-level withs were dropped). Probed the exact shape:
  a `throw value;` from inside the with body **escapes the enclosing
  top-level `catch`** (uncaught `WebAssembly.Exception` at module init in a
  clean probe; the published `__str_concat` deref is the harness variant of
  the same escape). Mechanism: module-init exception plumbing around a with
  body, not string concat and not dynamic scope.
- **29× Tier-2 refusal** (`body contains a nested function or class`): the
  #2663-deferred closure-capture-of-object-environment tier. Hard; grew from
  12 because previously-dropped withs now honestly reach the refusal.
- **27+13+15+13× annexB decl-update/init families** ("first declaration" /
  "outer declaration" / "Initialized binding created prior to evaluation" /
  "binding is initialized to undefined"): L3's ground — #2200 Phase 2 +
  B.3.3 update semantics; the 15 `Initialized binding` ones are the AOT
  twins L3 flagged as needing #2200 Phase 2 (last attempt −1180, do not
  retry without a local slice over the regressed buckets).
- **24× `SyntaxError: NaN`**: L3's two-layer diagnosis stands (#4178 fix
  alone will not flip them; a compiled-acorn scope-tracking defect sits
  behind the message).

## Substrate gaps found and deliberately NOT fixed here

- **`__extern_has` has no closed-struct field arm** (`object-runtime.ts`
  ~3123): `k in o` and the Tier-2 with HasBinding gate answer 0 for a
  closed-struct receiver (probe: `dynIn({y:1},"y")` false while
  `Object.hasOwn` true). Tier-1 W1 covers the dominant `var o={…}; with(o)`
  pattern, so post-#4179 this is a narrow residue (non-provable targets like
  `with (o || null)`).
- **`__extern_set` has no closed-struct write-through** — that is #4098 G1
  **stage 2 by design** (ordering law from #4010: deletability → visibility →
  write-through; stage 1 = instance tombstones, landed). Do NOT bolt it on
  ad-hoc; it interacts with the descriptor-family lane (W5).
