---
id: 4182
title: "annexB B.3.3.2 global-code: top-level block-nested function declarations bind STATICALLY (funcMap) instead of through a live module-global — ~38 ES5 standalone files"
status: done
assignee: ttraenkler/W7-annexb-global-blockfn
sprint: 78
created: 2026-08-06
completed: 2026-08-06
priority: high
# (#3596) Auto-parked from the merge_group on 2026-08-07 (batched with the
# already-merged #4137, so the delta is attributable here). The ONLY hard gate
# failure was the #3189 uncatchable-trap ratchet: illegal_cast 44 → 45 (+1).
# Both newly-trapping files were `fail` on the baseline — this is a change of
# failure MODE, not a conformance regression, which is exactly the #3596
# baseline-did-testify branch rather than the #3595 never-instantiated class.
# Mechanism: this change makes a module-scope sloppy block-function bind
# through a live module-global instead of statically through funcMap, so a
# sloppy assignment to an UNRESOLVABLE reference inside async destructuring now
# executes further than it previously did and reaches a pre-existing latent
# illegal_cast rather than stopping earlier. The trap is not introduced by this
# PR; it is reached by it. All other trap categories are flat in the same run
# (null_deref 1626→1621, oob 44→44, unreachable 3→3) and the run is net
# +56 pass (32040 → 32096), host stable-path fine-gate net +102.
trap-growth-allow:
  count: 2
  reason: "#3596 reclassification, fail -> fail (flavour only; neither test has ever passed). Live module-global binding for module-scope block functions lets the sloppy put-to-unresolvable in these two async destructuring tests run past the point it previously stopped, reaching a pre-existing latent illegal_cast. Growth is +1 net on the category with both newly-trapping files named below, as #3596 requires. No other trap category moved (null_deref 1626->1621, oob 44->44, unreachable 3->3); run net +56 pass, fine-gate net +102, and the PR's own exposure population measured ZERO pass->fail conversions."
  tests:
    - test/language/statements/for-await-of/async-func-decl-dstr-obj-id-put-unresolvable-no-strict.js
    - test/language/statements/for-await-of/async-func-decl-dstr-obj-prop-put-unresolvable-no-strict.js
loc-budget-allow:
  # Each arm below is position-dependent inside an existing dispatch and cannot
  # live in the new subsystem module (src/codegen/annexb-global-live-binding.ts,
  # which carries the actual logic):
  # typeof arm must precede BOTH static folds inside compileTypeofExpression
  # (mirrors the #2200 annexBOuterBindings arm):
  - src/codegen/typeof-delete.ts
  # two new context fields + their doc comments:
  - src/codegen/context/types.ts
  # two registration call sites, mirroring #2931's placement:
  - src/codegen/index.ts
  # seed-loop split ($undefined seed vs top-level closure seed) inside
  # compileModuleInitBody — the #2931 seed loop lives there:
  - src/codegen/declarations.ts
  # live-call gate widening in the identifier-call dispatch:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  # Same position-dependence as the loc allowances above — each is a small
  # gated arm inside an existing dispatch, not extractable logic:
  # seed-loop split inside compileModuleInitBody (nested in compileDeclarations):
  - src/codegen/declarations.ts::compileDeclarations
  # catch-param localMap leak fix, scoped to annexBModuleBindings names:
  - src/codegen/statements/exceptions.ts::compileTryStatement
  # live-call gate widening:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  # one registration call site each (mirrors #2931's placement):
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: codegen
language_feature: annexb-function-hoisting
goal: standalone-gap
related: [2200, 4131, 4137, 4139, 2931, 3419, 4179]
origin: "2026-08-06 W6-dynamic-scope — diagnosis of the annexB decl-update/init buckets on the dynamic-scope lever after #4179; design written instead of implemented (budget boundary, coordinator-approved stop)."
---

# #4182 — B.3.3.2 for global code: block-fn bindings must be LIVE, not static

## Population (measured on the post-#4179 lever A/B, `.tmp/w6/AFTER1.json`)

annexB/language/**global-code** slices of five error buckets, ≈38 files:
`existing-block-fn-update` (5) + `outer/inner declaration` (8) +
`*-init` "binding is initialized to undefined" (8) + "Initialized binding
created prior to evaluation" (8) + typeof-f variants (9). The
**function-code** twins (≈42) are #2200 Phase 2 territory (last attempt
−1180, see #4137/L3 handoff) and are explicitly OUT of scope here; the
**eval-code** twins (≈16) are the interpreter's (#4137).

## Mechanism (probed, current main + #4179)

A module-level block-nested `function f` is today hoisted into `ctx.funcMap`
like a top-level declaration, so bare `f` at top level resolves **statically**
to the compiled function — while reads inside other functions see nothing:

- probe A (bare top-level reads): `f` is `"function"` BEFORE the block runs
  (spec: `undefined` — B.3.3.2.b CreateGlobalFunctionBinding(F, undefined)),
  and calls the block fn after — the `-init` family fails on the pre-read.
- probe B (reads via a helper function): `typeof f` is `"undefined"` both
  before AND after the block — the evaluation-point SetMutableBinding
  (B.3.3.2.c.vi) never happens; the `-update` family fails on this.
- With an outer `function f(){outer}` + a later block `f(){inner}`, the
  static last-wins registration (#3419) picks one winner at compile time;
  spec wants outer-at-GDI then inner-after-block-evaluation.

The existing annexB machinery is FUNCTION-scoped and cannot fire here:
`fctx.annexBOuterBindings` (TDZ locals, `statements/nested-declarations.ts`
~1936-1975) and the #4131 `annexBUpdatesExistingVarBinding` store
(`statements.ts` ~222-300) both write `fctx.localMap` locals —
`__module_init` bindings are module GLOBALS, so both arms no-op.

## Design (reuse the #2931 live-binding-global mechanism)

For each module-level, annexB-ELIGIBLE (not `annexBHoistCancels`-cancelled)
block-nested `function f`:

1. `registerModuleGlobal(f, externref)` — the web-compat var binding.
2. Route bare reads of `f` through the global (the #2931
   `liveFuncBindingGlobals` read arm), NOT the static funcMap closure.
3. Seeding split (`declarations.ts` ~2492, the #2931 seed loop):
   - name ALSO declared as a real top-level `function f` → seed with THAT
     closure (GDI initializes it normally);
   - name declared ONLY in blocks → do NOT seed (binding starts undefined).
     Needs a marker set (e.g. `ctx.annexBModuleBindings`) because the seed
     loop currently seeds every live name from funcMap.
4. Evaluation point: in `statements.ts`' FunctionDeclaration arm, BEFORE the
   `funcMap.has(funcName)` early-return, when compiling module-init and
   `funcName ∈ ctx.annexBModuleBindings`: emit
   `emitCachedFuncClosureAccess` → `extern.convert_any` → `global.set` —
   the module-global mirror of the #4131 `emitAnnexBVarUpdate` local arm.
5. Cancellation: reuse `annexBHoistCancels` (lexical shadow / same-named
   catch param). `script-decl-lex-collision.js` (top-level `let f`) must NOT
   create the global binding.

## Hazards (why this was not knocked out in an hour)

- **Exposure is every top-level block/if/switch-nested function in the
  corpus**, not just the 38: flipping resolution from static to live changes
  call-before-block behavior from "works" to "undefined/TypeError" — CORRECT
  per spec, but any vacuously-passing caller flips. Needs an A/B over a
  grepped exposure list (same discipline as #4179's, which had 10 honest
  conversions).
- The #2931 seed loop dedupes by global index and runs before user
  statements — ordering with the deferTopLevelInit / runtime-eval adapter
  arms must be preserved.
- Do NOT let this leak into function-code (#2200 Phase 2): keep every change
  gated on module-init compilation.
- `verifyProperty(global, "f", …)` in the `-init` family additionally needs
  the binding visible on the global object (enumerable, non-configurable) —
  the standalone globalThis reflection may cap the yield below 38; measure
  per-file, some may only get past assert #1.

## Implementation notes (2026-08-06, W7 — why, not just what)

Implemented exactly per the design above (`src/codegen/annexb-global-live-binding.ts`
+ gated arms in statements/typeof-delete/call-identifier/declarations/exceptions).
Measured: **lever 98 → 144 of 153** (full `annexB/language/global-code`,
standalone, fresh #4162 provider), **exposure 151 → 191 of 246** (every
non-strict non-module test262 file with a module-scope Annex-B-position fn),
**zero regressions in both, zero vacuous-pass conversions**. Remaining 9 are
`$262.evalScript` interpreter-side (#4137-adjacent). Three findings the design
did not fully anticipate:

1. **The seed must be the `$undefined` singleton, standalone-only.** A
   `ref.null.extern` init reads back as JS `null` under the #2106
   `undefinedSingleton` regime (`«null» ≠ «undefined»`, 24 lever files), while
   in the HOST lane the singleton surfaces to host helpers as an opaque
   object (`typeof` → "object", `=== undefined` → false) — so the seed arm
   gates on `ctx.standalone || ctx.wasi` and the typeof arm branches on
   `ref.is_null` before dispatching `__typeof`.
2. **The catch parameter LEAKS in the flat localMap** when it shadows nothing:
   the restore path only handled the had-a-previous-local case, so
   `*-no-skip-try`'s post-try reads resolved the leaked `catch (f)` local
   forever. Fixed with a delete scoped to `annexBModuleBindings` names — the
   general leak is pre-existing surface other resolution paths may lean on
   (follow-up candidate).
3. **The reassignment exclusion must scan INTO nested function bodies** —
   `*-block-scoping`'s write (`f = 123`) sits inside the block fn's own body,
   which #2552's function-scope scan deliberately skips. One shared global
   cannot model the block-local/var-binding split, so any name written
   anywhere inside its declaring range stays on the legacy path
   (byte-identical, keeps `*-block-scoping` passing).
