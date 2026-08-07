# W7 — annexB global-code block-fn live binding (2026-08-06): context + PR body

Agent `ttraenkler/W7-annexb-global-blockfn`. Issue **#4182** (claimed on
`origin/issue-assignments`), branch `issue-4182-annexb-global-blockfn`.
Implements the design written by W6 in
`plan/issues/4182-annexb-global-code-block-fn-live-binding.md` as specified —
no re-derivation was needed; the diagnosis held exactly.

## PR body (verbatim)

Closes #4182. Measured on the full `annexB/language/global-code` directory
(153 files, standalone lane, local in-process runner with a fresh #4162
provider built from this branch): **98 → 144, zero regressions**. Exposure
population — every non-strict, non-module test262 file with a MODULE-scope
block/`if`/`switch`-nested function declaration (246 files, scanned on this
tree): **151 → 191, +40 fixes, ZERO pass→fail conversions** (unlike #4151's
10 and #4179's 10, this change converted no vacuous passes — the affected
statements already executed; only their binding resolution changed).

### Root cause (W6's #4182 diagnosis, confirmed by probe)

A module-scope sloppy `{ function f() {} }` bound STATICALLY through
`ctx.funcMap`:

- pre-evaluation reads saw the compiled function (B.3.3.2.b says the binding
  is created as `undefined` at GlobalDeclarationInstantiation);
- the B.3.3.2.c evaluation-point `SetMutableBinding` never happened, so an
  outer `function f` was never updated by a later block `f`
  (`*-existing-fn-update`: read "outer declaration" forever), and a second
  same-named block declaration was silently skipped by the `funcMap.has`
  early-return in the FunctionDeclaration statement arm
  (`*-existing-block-fn-update`).

The function-scope Annex B machinery (`fctx.annexBOuterBindings` TDZ locals,
#4131's existing-var update) writes `fctx.localMap` LOCALS and cannot fire at
module scope, where bindings are module GLOBALS.

### Fix — reuse the #2931 live-binding-global mechanism

New module `src/codegen/annexb-global-live-binding.ts`; every arm is gated on
the normally-empty `ctx.annexBModuleBindings` set, so programs without a
module-scope sloppy block function are byte-identical.

1. **Registration** (`registerAnnexBGlobalLiveBindings`, run beside #2931's
   `registerReassignedFunctionGlobals` in both generateModule paths): for each
   eligible name — Annex B statement position, enclosing var scope is the
   SourceFile, no intervening lexical binder (`hasInterveningLexicalBinder`,
   now exported), no top-level `let`/`const`/`class` (B.3.3.2.a) — back the
   name with a mutable externref module global (reusing an existing `var`
   global, widening f64/i32 carriers; ref-typed carriers bail to today's
   path), and mark it in `annexBModuleBindings` + `liveFuncBindingGlobals` +
   `globalObjectVarBindings`. Strict/module sources are skipped entirely
   (`isStrictContext`), which confines the pass to script-mode compiles.
2. **Seed split** (the #2931 seed loop in `compileModuleInitBody`): a name
   that is ALSO a real top-level `function f` seeds that closure (GDI
   initializes it); a block-only name seeds the `$undefined` singleton
   (standalone/WASI — the host lane's undefined IS the null extern, and the
   tag-1 singleton would surface to host helpers as an opaque object). Without
   the split, pass 2 of the #2965 two-pass init compile seeded the block
   function's closure and the pre-evaluation read wrongly observed it.
3. **Evaluation point** (`tryCompileAnnexBModuleBlockFnEvaluation`, statements.ts
   FunctionDeclaration arm, BEFORE the `funcMap.has` early-return): compile
   THIS declaration node as its OWN Wasm function (funcMap entry temporarily
   cleared to force a fresh registration; top-level ownership restored so the
   seed loop keeps resolving the GDI winner; idempotent across the two-pass
   init compile via a per-node WeakMap) and `global.set` its closure —
   B.3.3.2.c.v–vi.
4. **Reads/calls/typeof**: identifier reads route through the module-global
   arm; identifier calls take the live dynamic-dispatch path (gate widened at
   `call-identifier.ts` — a direct funcMap call would pin the GDI winner
   forever); `typeof` gets a dedicated arm ahead of BOTH static folds
   (`ref.is_null` → "undefined" for the host lane's null pre-state, else
   `__typeof`, whose standalone tag dispatch answers "undefined" for the
   singleton and "function" for closures).
5. **Catch-param leak fix** (`exceptions.ts`, scoped to these names): with no
   prior local to restore, a `catch (f)` parameter stayed in the flat
   `localMap` past the catch scope and shadowed the live global forever
   (`*-no-skip-try` read the leaked local). The general leak is pre-existing
   and other paths may lean on it, so the delete is gated on
   `annexBModuleBindings`.

**Exclusion:** a name REASSIGNED inside its declaring range keeps today's
static path — the spec's block-LOCAL lexical binding is distinct from the
global var binding (`{ function f() { f = 123; } }` mutates only the block
binding; `*-block-scoping` asserts exactly this) and one shared global cannot
model the split. Excluded names are byte-identical to main.

### Remaining 9 lever failures, itemized (all out of AOT scope)

- 8× `*-existing-non-enumerable-global-init`: the assertions live inside
  `$262.evalScript(...)` strings — interpreter-side GDI (#4137-adjacent).
- 1× `script-decl-lex-collision`: expects a SyntaxError from a SECOND
  `$262.evalScript` colliding with the AOT script's function binding —
  interpreter-side.

### Boundaries honored

- **Function-code (#2200 Phase 2) untouched** — every new arm is gated on
  module-init compilation (`fctx.name === "__module_init"`) or the
  `annexBModuleBindings` membership; the −1180 ground is not entered
  (`tests/issue-2200-annexb-block-fn-hoist.test.ts`,
  `issue-2552-annexb-phase2.test.ts`, `issue-4131.test.ts`,
  `issue-3980.test.ts`, `issue-2931.test.ts` all pass).
- **Eval-code untouched** (#4137). `tests/issue-3633-eval-annexb-bindings.test.ts`
  fails 4/4 both on this branch AND on origin/main src (verified by src swap)
  — pre-existing, not from this change.
- `src/codegen/declarations.ts` touched only in the seed loop (guard + seed
  arm); no overlap with #4151/#4181's collection-arm territory.

### Gates

`tsc --noEmit` clean; `check:oracle-ratchet` / `check:coercion-sites` /
`check:ir-fallbacks` clean; `check:loc-budget` / `check:func-budget` green via
per-entry-justified `loc-budget-allow` / `func-budget-allow` in the issue file
(the position-dependent arms live inside existing dispatches; the logic is in
the new subsystem module). `tests/issue-4182-annexb-global-blockfn.test.ts`
9/9; `tests/equivalence/` clean (see CI).

## Measurement instruments

- `.tmp/w7/run-lever.mts` (W6's #4162-shimmed in-process standalone runner,
  provider rebuilt from this branch: key `854c120ce015d507`).
- `.tmp/w7/scan-exposure.mts` — the 246-file exposure scan (non-strict,
  non-module, module-scope Annex-B-position function declarations).
- A/B pairs: `.tmp/w7/BASE.json`/`AFTER3.json` (lever),
  `EXPO-A.json`/`EXPO-B.json` (exposure; base measured with
  `git checkout origin/main -- src` on the same instrument).

## Deliberately left undone

- The `$262.evalScript` interpreter-side GDI twins (9 files above).
- The general catch-param localMap leak (unscoped variant) — follow-up
  candidate; flagged in the exceptions.ts comment.
- In-block reads BEFORE the declaration statement inside the same block see
  the seed value rather than the hoisted block binding (spec: the block
  binding is initialized at block entry). No test262 file in the lever or
  exposure population reads that window.
- `verifyProperty(global, "f", …)` descriptor introspection beyond what the
  standalone global-object reflection already supports (names are registered
  in `globalObjectVarBindings`; the `-init` family passes).
