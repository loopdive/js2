---
id: 2965
title: "Standalone dynamic-descriptor/defineProperty cluster (~694 host-pass→standalone-fail: defineProperty 398 + gOPD 184 + defineProperties 112)"
status: done
completed: 2026-07-02
assignee: ttraenkler/fable-6
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen, runtime
goal: standalone-mode
related: [2372, 2896, 2944, 2915, 2861, 2863, 2907, 2962]
origin: "2026-07-02 July Fable audit §3 — reflective descriptor cluster in the standalone correctness-fail bucket"
---

# #2965 — standalone dynamic-descriptor/defineProperty cluster

## Problem

**773 tests** under `built-ins/Object/{defineProperty,getOwnPropertyDescriptor,
defineProperties}` pass on the js-host lane but fail (694) or CE (79) on the
standalone lane (verified against `test262-standalone-current.jsonl` ×
`test262-current.jsonl`, 2026-07-02 — the audit's 398+184+112 reproduce
exactly).

## Measured triage (deliverable 1 — by construct, full 773)

| class                                                 | count                                   | mechanism                                                                                                                                  | status                                                                |
| ----------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| gOPD-on-builtin (incl. builtin-proto receivers)       | ~178 (60 CE `__get_builtin` + 118 fail) | `gOPD(Array.prototype, "forEach")` etc. needs the builtin-object MOP; descriptor `.value` must be the method value                         | follow-up — overlaps #2861/#2863/#2896 machinery (`__builtinfn_gopd`) |
| defineProperties 5-b/6-a slab                         | ~300                                    | mixed: materialized-typeof breakage (fixed below), array/arguments own-prop MOP, accessor attribute fidelity, destructive `verifyProperty` | partially fixed (typeof); rest follow-up                              |
| arguments-object receivers                            | ~82                                     | defineProperty on mapped `arguments`                                                                                                       | follow-up (see #2667 lineage)                                         |
| gOPD non-string literal keys                          | ~24+                                    | ToPropertyKey not applied → undefined → opaque throw on `.value`                                                                           | **FIXED** (slice 3)                                                   |
| boxed-wrapper receivers (`new String/Number/Boolean`) | ~18                                     | defineProperty on boxed wrappers                                                                                                           | follow-up                                                             |
| global-object receivers (`this` at top level)         | ~10                                     | needs #2907 global carriers                                                                                                                | follow-up                                                             |
| assert.throws(TypeError) missing                      | ~32                                     | missing spec throws (array length, non-extensible, etc.)                                                                                   | follow-up                                                             |

The 279 "uncaught Wasm-GC exception (non-stringifiable payload)" entries are
NOT one bucket — they decompose into the classes above (the opacity itself is
#2962's scope; the throws here are mostly genuine wrong-behavior throws).

## Root causes found + FIXED in this branch (deliverable 2)

1. **Module-init double-compile state leak** (`src/codegen/declarations.ts`).
   `compileModuleInitBody()` runs twice by design (second pass sees the final
   inlinable-function registry). Statement compilation mutates program-order
   state (`definedPropertyFlags`, `frozenVars`/`sealedVars`/
   `nonExtensibleVars`); pass 2 started from pass 1's END state, so **every
   first top-level `Object.defineProperty(o,k,{value:v≠0})` threw a spurious
   "Cannot redefine property"** (needsValueCompare guard vs the struct field's
   zero-init default) and defines preceding `Object.freeze` compiled as
   already-frozen. Fix: snapshot before pass 1, restore before pass 2. Affects
   ALL lanes' top-level code (test262's runner wraps bodies in `test()`, so
   the corpus mostly doesn't hit it — but user code / playground does).

2. **`__typeof` standalone native was a `ref.null.extern` stub**
   (`src/codegen/index.ts` `addUnionImportsAsNativeFuncs`). Every MATERIALIZED
   typeof (`var t = typeof x`, typeof through a param, and the runner's
   untransformed paren-form `typeof(o.p)` — common in ES5-era tests) produced
   null: `t === "<tag>"` false for every tag, `t.length` trapped. Fix: real
   classifier mirroring the `__typeof_*` predicates (null→"undefined",
   box_number→"number", box_boolean→"boolean", $BigInt→"bigint",
   $AnyString→"string", else→"object"), returning inline NativeString
   constants (type-index-only instrs — late-import-shift safe, #2515
   discipline). Known pre-existing conflation kept: null externref is
   indistinguishable from undefined (typeof null → "undefined"), same as the
   `__typeof_undefined` predicate. gc/host lane untouched (block is
   `ctx.wasi || ctx.standalone` gated).

3. **gOPD literal-key ToPropertyKey** (`src/codegen/expressions/calls.ts`).
   The struct fast path required a string-literal key; `gOPD(obj, -20)` /
   `gOPD(obj, true)` fell to the dynamic `__getOwnPropertyDescriptor` native,
   which answers undefined for typed-struct receivers. Fix (standalone-gated):
   canonicalize numeric/boolean literal keys to their §7.1.19 string form so
   they hit the same fast path.

## Test results

- `tests/issue-2965.test.ts` — 11/11 pass, host-free asserted.
- gOPD `15.2.3.3-2-*` (47 files, real runner, standalone): **+23 flips, 0
  regressions** vs baseline.
- 155-file deterministic sample of the 694: +8 in-sample (the corpus bulk
  needs the follow-up MOP classes above).
- 221-file regression sweep over baseline-PASSING standalone tests across all
  categories: 215 pass + 6 Temporal skip-scope artifacts, **0 regressions**.
- Equivalence-suite run was IN FLIGHT at suspend (see below).

## Resolution (2026-07-02, fable-6)

Shipped the three root-cause fixes above on branch
`issue-2965-standalone-descriptor-cluster` (PR to `loopdive/js2`).

**gc-lane gate (the withheld-PR check)**: the four anomalous equivalence
suites seen mid-run (tagged template literals 11F, coercion/arithmetic-add 8F,
TDZ 6F, arguments for-loop 1F) were A/B'd against the unmodified base —
**identical failures on clean base, zero caused by this branch**. (The tagged
template compile-errors on clean main may be a recent main regression —
flagged to the lead, out of scope here.)

**Honest measured delta** (real runner, standalone lane):

- gOPD `15.2.3.3-2-*` key-coercion class (47 files, exhaustive): **+23 / 0 reg**
- 155-file deterministic sample of the 694-cluster: **+8 in-sample** (≈ +40
  extrapolated over the 773; the remaining bulk needs the follow-up MOP
  classes in the triage table)
- materialized-typeof construct OUTSIDE the cluster (44 failing files,
  exhaustive): **+6**
- broad unbiased sample of all 17,097 other standalone fails (150 files):
  **0 flips** — these fixes are construct-specific; no broad-movement claim
- 221-file passing-test regression sweep: **clean** (6 Temporal skip-scope
  artifacts only)
- Slice 1 additionally fixes top-level user code in EVERY lane (spurious
  "Cannot redefine property" on all top-level defineProperty; freeze-order
  miscompiles) — the test262 runner wraps bodies in `test()`, so the corpus
  barely exercises it, but the playground/diff lanes do.

## Follow-ups (from the triage — filed as issues, #38)

- **#2984** gOPD-on-builtin (~178): extend #2861/#2863/#2896 `__builtinfn_gopd`
  machinery
- **#2985** defineProperties 5-b/6-a slab residual (~250: array/arguments own-prop
  MOP + accessor fidelity + destructive `verifyProperty`); folds in the
  `__obj_find` illegal-cast on residual dynamic non-string keys (2 files)
- **#2986** arguments-object defineProperty MOP (~82, #2667 lineage)
- **#2987** boxed-wrapper receivers (~18)
- **#2988** global-object receivers (~10, blocked on #2907)
- **#2989** missing spec TypeErrors (~32: array length, non-extensible,
  non-configurable redefine)
