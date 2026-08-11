---
id: 2552
title: "Annex B B.3.3 Phase 2 rework — TDZ-var outer-binding allocation perturbs hot-path codegen (-1180 test262 regression)"
status: ready
sprint: current
created: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: annex-b, block-functions
goal: es5
parent: 2200
related: [2200, 1764]
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/eval-inline.ts
origin: "2026-06-19 — #2200 Phase 2 (PR #1769) failed the full test262-regression gate -1180; parked Phase-1-only. This is the rework follow-up."
---

# #2552 — Annex B Phase 2 rework: TDZ-var allocation perturbs hot-path codegen

> **ID note (2026-06-20):** originally drafted as `#2514`, which collided with
> the already-on-main `#2514` (runtime-helpers-as-shared-linkable-module).
> Renumbered to `#2552` via the atomic allocator (`claim-issue.mjs --allocate`).

## Context

#2200 Phase 1 (#1764, ~93-test floor: case-A cancellation) is **merged and stands
alone**. Phase 2 (case-B uninitialised-then-init outer var-binding + `typeof`
resolution) was implemented on branch `issue-2200-annexb-phase2` (PR #1769) but
the **full CI test262-regression gate flagged -1180 net pass (1411 regressions,
231 improvements)** — so Phase 2 is parked (PR #1769 → draft) pending this rework.

## The regression (gate bucket output, signature `d57ce880bc38ea96`)

- categories: `wasm_compile: 625`, `null_deref: 593`, `type_error: 143`, other 41.
- top buckets (each >50): `Array/prototype/{some 115, every 113, filter 109,
  map 93, forEach 86, reduceRight 69, reduce 58}`,
  `language/statements/{function/dstr 88, generators/dstr 88,
  async-generator/dstr 52}`.

**Confirmed NOT drift:** PR #1767 ran its gate against the SAME fresh baseline
seconds apart and was clean (+21, different signature, 3 files). The -1180 is
specific to #1769's 4-file Phase 2 delta (`context/types.ts`, `statements.ts`,
`nested-declarations.ts`, `typeof-delete.ts`; `array-methods.ts` byte-identical to
main).

## Root cause (hypothesis — needs local-slice confirmation)

The Phase 2 **TDZ-var allocation in `hoistFunctionDeclarations`**
(`src/codegen/statements/nested-declarations.ts`): `annexBBlockNestedEligible`
→ for any block-nested function it does `allocLocal(fctx, funcName, externref)` +
an `__tdz_<name>` i32 flag and records `annexBOuterBindings`. The `null_deref` /
`wasm_compile` categories across hot-path Array methods + `*/dstr` strongly
suggest this **perturbs local-index layout** (or leaves an uninitialised
outer-binding externref local that a shared codegen path reads) for the dominant
test262 harness shape: a function that merely **contains** a block-nested helper
(the Array-method test files wrap assertions + helper fns in blocks). The
gate fails, but it does NOT reproduce in targeted local compiles (standalone OR
host) of realistic shapes — it lives in test262's specific harness/strict-mode
config.

## Rework plan

1. **Reproduce FIRST against a local test262 slice** over the flagged buckets
   (`built-ins/Array/prototype/{some,every,filter,map,forEach,reduce,reduceRight}`
   + `language/statements/{function,generators,async-generator}/dstr`) — do NOT
   attempt a blind patch. Use `pnpm run test:262` scoped to those paths (or the
   runner's category filter) on the `issue-2200-annexb-phase2` branch vs main to
   get the exact failing files + WAT.
2. **Narrow `annexBBlockNestedEligible`** so the outer-binding TDZ-var is
   allocated ONLY when the outer binding is actually OBSERVED (read/typeof'd
   outside the declaring block) — a function that merely *contains* a block-nested
   helper, or whose block-fn name is never referenced at function scope, must be
   byte-identical to pre-Phase-2 codegen (no `allocLocal`, no flag, no
   `annexBOuterBindings` entry). The current gate fires on mere structural
   eligibility, which is too broad.
3. **Preserve the typeof-resolution fix** (`emitAnnexBTypeofFlagBranch` invoked at
   the top of the undeclared-identifier branch in `typeof-delete.ts`) — it is
   correct and reusable; the bug is in the allocation breadth, not the typeof
   read.
4. **Re-validate against the FULL gate** (not just local unit tests) before
   re-opening #1769 / a fresh PR — the local Phase-2/typeof/scope tests passed
   while the broad gate caught the regression, so a local-slice + full-gate
   re-run is mandatory.

## WIP / branch

`issue-2200-annexb-phase2` (PR #1769, draft). Phase 2 plumbing + the correct
typeof fix + the full regression diagnosis live there. Phase 1 floor is on main
(#1764).

## Acceptance criteria

- The case-B behaviours work (TDZ binding / value / in-block call / if-skip /
  `typeof` after-block→"function", before/skip→"undefined") — i.e. the Phase 2
  unit tests pass.
- The full test262-regression gate is **net ≥ 0** with no bucket >50 and ratio
  <10% (no Array/prototype/* or */dstr regression).
- `#2200` can then close (both phases complete).

## Resolution (2026-06-21, sendev-funcidx)

Reintroduced the reverted Phase-2 source (the inverse of revert `925db38df`:
`context/types.ts` `annexBOuterBindings`, `statements.ts` decl-site init,
`nested-declarations.ts` eligibility+alloc, `typeof-delete.ts`
`emitAnnexBTypeofFlagBranch`) onto current upstream/main, then **narrowed the
allocation breadth** — the single root cause of the -1180.

**The narrowing.** `annexBBlockNestedEligible` (nested-declarations.ts) now
additionally requires `annexBNameObservedOutsideBlock(name, block)`: the
block-fn's name must be referenced as a value (read / `typeof` / call / arg —
`isAnnexBValueReference`) somewhere in the enclosing Annex-B scope OUTSIDE its
declaring block. The scan walks the enclosing function/SourceFile body, skips the
declaring block and any nested function scope, and excludes property/declaration/
label names. When the name is NOT observed outside its block — the dominant
test262 harness shape (a function that merely *contains* block-nested helpers) —
NO outer-binding local, NO `__tdz_` flag, and NO `annexBOuterBindings` entry are
emitted, so codegen is byte-identical to pre-Phase-2. The case-B lifecycle is
implemented exactly where it is observable.

**Byte-identity verified** (compile-and-hash, my branch vs clean upstream/main):
single-helper, multi-helper, dstr-style, nested-block, and a realistic
Array.prototype verifyProperty-style harness (multiple block-nested helpers used
only within their blocks) — ALL produce identical binaries. This is the direct
evidence the -1180 hot-path perturbation does not recur.

**Case-B behaviours verified** (`tests/issue-2552-annexb-phase2.test.ts`, 10
cases): `typeof F` after-block→"function", skip/before→"undefined", `F()` after
block→value, unobserved-helper still callable in-block, undeclared→"undefined",
normal fn-body decl→"function", numeric local→"number", and case-A cancellation
(let-shadow → ReferenceError) intact. `typecheck` + `format:check` + `lint` +
`check:stack-balance` + `check:issues` clean.

Pre-existing failures `tests/finally-block.test.ts` (5) and
`tests/issue-1712-capture-closure-dispatch.test.ts` (1) reproduce identically on
clean upstream/main — NOT regressions.

**Full-gate is the final arbiter** (the -1180 could not be pre-validated locally;
byte-identity on the flagged shapes is the local proxy). On the gate landing
net ≥ 0, `#2200` closes (both phases complete).

## Merge_group result + diagnosis (2026-06-21, sendev-funcidx review)

PR #1817 was un-held and enqueued once (GraphQL `enqueuePullRequest`, user PAT)
to let the merge_group test262 gate arbitrate. It **EJECTED** on the
`check for test262 regressions` job (runs 27901419024 + 27901413332, both
completed/failure). The hold was re-applied; **not re-enqueued** (one-shot rule;
auto-enqueue backstop owns re-adds).

**The narrowing WORKED — the -1180 is gone.** Gate output:
`net -10` (32920→32910 pass), **regression bucket signature `a0df2c22d5af927e`,
10 non-CT files, 0 improvements**, ratio ∞ (10/0). The gate fails purely on
`net < 0` / ratio ≥ 10 %, NOT on the old hot-path buckets. There is **zero**
`Array/prototype/*` or `*/dstr` regression. Independent byte-identity (7
unobserved harness shapes, hash-identical PR-HEAD vs merge-base `1f88850a`) is
confirmed sound.

**All 10 regressed files are the Annex B feature's OWN observed-case path**
(diffed merged-report jsonl vs baseline):

- 8× `test/annexB/language/function-code/*-func-existing-block-fn-no-init.js`
  (`block-decl`, `if-decl-else-decl-a/b`, `if-decl-else-stmt`,
  `if-decl-no-else`, `if-stmt-else-decl`, `switch-case`, `switch-dflt`):
  error **`f is not defined`** (error_category `other`).
- 2× `*-block-scoping.js` (`block-decl-func-block-scoping`,
  `block-decl-global-block-scoping`): `initialBV()`/value assertions
  (`assertion_fail`).

**Root cause (confirmed by local repro on the PR branch).** Phase 2 wires the
`annexBOuterBindings` outer-binding local for exactly TWO consumers — the
decl-site init (`statements.ts`) and `typeof F` (`typeof-delete.ts`). A **bare
value READ** of an observed Annex B name is NOT wired to the synthetic externref
outer-binding local. So for the `no-init` shape:

```js
(function () {
  init = f;            // observed READ before block → resolves via the normal
                       // identifier path, which does NOT find the synthetic
                       // outer-binding local → "f is not defined"
  { function f() {} }
  { function f() {} }
}());
assert.sameValue(init, undefined);   // spec: binding EXISTS, uninitialised → undefined
```

Local repro on `99cf4c0a1`: `init = f` before the block throws **`f is not
defined`** (should yield `undefined` — the var binding exists, just
uninitialised, so a read is NOT a ReferenceError). `typeof f` works (it's wired);
a *call* `f()` after the block works (resolves via `funcMap`); but a bare
read/assignment-read and the mutable-binding read/`f = 123` value semantics
(`block-scoping`: `initialBV()`/`currentBV`) are unwired.

**The -10 FIX (2026-06-21, sendev-funcidx — three coordinated changes).**

1. **Bare value-read interception** (`identifiers.ts`, in `compileIdentifier`,
   BEFORE the generic localMap/`tdzFlagLocals` path). A bare read of an
   `annexBOuterBindings` name now emits a flag-gated read: flag 1 ⇒ the
   outer-binding externref local; flag 0 ⇒ `emitUndefined(...)`. Crucially this
   yields `undefined` — NOT a ReferenceError — because the var-style binding
   EXISTS. The previous behaviour reused the shared let/const `tdzFlagLocals`
   path, so a textually-before read hit `emitStaticTdzThrow` → "f is not defined"
   (the 8 `*-no-init` files). `undefined` is materialised into the MAIN body
   first (late-import-shift-safe), stashed, then `select`ed on the flag — same
   pattern as `emitAnnexBTypeofFlagBranch`. Gated on the normally-empty
   `annexBOuterBindings` set → byte-identical for every other read.

2. **Mutable-binding exclusion** (`annexBNameReassignedInBlock`,
   nested-declarations.ts). The 2 `*-block-scoping` files use
   `{ function f() { f = 123; … } }` — the in-block reassignment splits the
   block-local binding from the outer var binding (per §B.3.3 the outer binding
   captured the function at block entry and is independent of the later mutation).
   The single-slot flag-gated machinery can't model that split, so a name
   reassigned anywhere in its declaring block subtree is excluded from the outer
   binding and reverts to the (passing) pre-Phase-2 path.

3. **Existing-`var` exclusion** (`annexBSameNameVarIn­Scope`,
   nested-declarations.ts). Per §B.3.3 step 2 ("If instantiatedVarNames does not
   contain F"), a same-named `var F` already in the enclosing function/global
   scope means NO fresh outer binding — the function uses the existing var. The
   existing var may be a non-externref slot (e.g. an f64 number, as in
   `block-decl-func-existing-var-no-init`: `var f = 123`); allocating an externref
   outer binding on top desyncs the type and the new read path emits
   `expected externref, got f64`. This was a regression my read-interception
   newly EXPOSED (the file was `pass` on PR-HEAD because nothing consumed the
   stray binding); the var-scan eligibility exclusion is order-independent and
   restores it.

**Validation (all local, on the fixed branch).**
- **All 10 merge_group-regressed files now PASS** (`runTest262File`): the 8
  `*-no-init` + 2 `*-block-scoping`.
- **Whole-tree no-regression**: `annexB/language/{function,global}-code` swept
  (312 files) on the fixed branch vs the pre-Phase-2 merge-base — **104/312 on
  both, ZERO new failures, zero recoveries** (i.e. exact base-parity; Phase-2
  now adds the case-B feature with no collateral). The `var-no-init` file the
  read-path first broke is included and passes.
- **Byte-identity intact**: all 7 unobserved harness shapes still hash-identical
  to the merge-base — the -1180 fix is undisturbed (the three new gates only make
  eligibility STRICTER; the read interception is `annexBOuterBindings`-gated).
- **Unit tests**: `tests/issue-2552-annexb-phase2.test.ts` now 13/13 (added
  bare-read-before-block→undefined, read-after→function, reassigned-in-block
  in-block-use). `typecheck` + `format:check` + `lint`(changed files) +
  `check:stack-balance` clean.

Expected merge_group delta: the -10 recovered, no new regressions → **net ≥ 0**.
On landing, `#2200` closes (both Annex B phases complete).

## Repeated declaration-object slice (2026-08-11, standalone refresh)

The latest forced standalone baseline (`2026-08-11 19:17`, oracle v13,
48,661 raw rows) does not contain the historical “91” as an exact maintained
population. Rebuilding the repository report's first-match
`annex-b-function-eval` heuristic yields **122** non-passing rows: **89 ES5**,
20 ES2015, and 13 ES2027. The ES5 89 is the reproducible selector/denominator
for this work; it is a mixed Annex-B/eval bucket rather than one mechanism.

The highest-yield coherent mechanism inside it was the generated function-scope
`*-existing-block-fn-update.js` family. The current Test262 checkout has eight
such function-code rows, all failing on main because the second declaration
stored the first declaration's function object again. The fresh maintained
baseline contains seven of those rows; the eighth
(`if-decl-else-decl-b-func-existing-block-fn-update.js`) arrived after that
baseline snapshot and was therefore measured from the current corpus rather
than silently dropped.

**Root cause.** Function-scope Annex B correctly has a live, flag-gated outer
binding, but `ctx.funcMap` and capture metadata are keyed by bare function name.
The hoist pass therefore compiled only one body for multiple same-named block
declarations. Every declaration-site assignment fetched that same `funcMap`
entry, and a direct call bypassed the live outer binding entirely. This is an
AST-hoist/codegen binding-identity defect, not an IR-selection defect; adding a
new IR route would not restore declaration identity.

**Implementation boundary.** Multiple eligible, capture-free, zero-parameter
ordinary declarations now compile declaration-specific function objects. Their
name is recorded as a repeated Annex B outer binding, and direct calls dispatch
through the live local so a skipped branch cannot pin the statically last body.
The eligibility scan includes block, Annex-B `if`, and switch declaration
positions, while excluding inner same-named block functions whose `var`
substitution would be an early error. Lone declarations keep the existing
direct-call path. Capturing/parameterized/async/generator duplicates remain
parked because capture metadata is still name-keyed; widening this slice without
per-declaration capture records produced an illegal/null closure path in the
local canary.

**Maintained A/B.** With the full standalone interpreter provider and one worker,
the exact 40-row selector (eight function-code targets plus 32 already-passing
global/eval controls) moved **32/40 → 40/40**. The final candidate also passed
the two broader-sweep canaries for the nested-cancellation and lone-catch cases
(**42/42** combined). A full current function-code sweep is **120/159** (38
runtime failures, one compile error). Against the 155 overlapping fresh-baseline
rows it is **110 → 117 pass**, with seven baseline failures recovered and **zero
pass-to-nonpass regressions**; three of four newly added corpus rows pass,
including the eighth target. Focused unit coverage passes on both GC and
standalone (15/15).

**Residuals.** The fresh ES5 report selector retains **82/89** baseline rows
outside this slice. In the narrower current function-code directory, **39/159**
remain non-passing: default-parameter skip (8), binding init (8), catch/try
no-skip (7), existing-function update (5), existing-function no-init (3),
mutable block scoping (3), early-error skip (3), `arguments` (1), and switch
redeclaration diagnostics (1). The next repeated-declaration slice must first
make capture/signature metadata declaration-keyed; it must not broaden the
capture-free gate opportunistically.
