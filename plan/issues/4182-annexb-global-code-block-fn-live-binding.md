---
id: 4182
title: "annexB B.3.3.2 global-code: top-level block-nested function declarations bind STATICALLY (funcMap) instead of through a live module-global — ~38 ES5 standalone files"
status: ready
sprint: current
created: 2026-08-06
priority: high
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
