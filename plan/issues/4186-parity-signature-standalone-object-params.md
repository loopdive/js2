---
id: 4186
title: "IR/legacy SIGNATURE split-brain on standalone implicit-any object params: lattice types acorn's `options` as a shape struct while legacy's `lowerParamType` deliberately refuses `__anon_*` — every such claim demotes at the typeIdx parity guard"
status: in-progress
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir
goal: backend-agnostic-ir
related: [4177, 4155, 2937, 3536, 3551, 1712, 2949]
assignee: ttraenkler/claude-fable-8
origin: "2026-08-06 — the exact 3 IR-FALLBACK errors every acorn dogfood run reports; the reason tests/issue-1712-standalone.test.ts (asserts errors: []) is red on main, invisible to required CI"
loc-budget-allow:
  # +21: the JS2WASM_DEBUG_ABI_PARITY diagnostic enrichment (dump the heap
  # types the two divergent functypes reference). It must live at the parity
  # guard itself — that is the only place both typeIdx values and ctx.mod.types
  # are in scope at the moment of the demotion decision. Debug-env-gated,
  # zero-cost when off.
  - src/ir/integration.ts
  # +2: one import plus the single projection call in `planIrOverlay`, applied
  # to `identityMaps` immediately after construction so BOTH consumers
  # (selection at planIrOverlayByIdentity and the override map built from
  # typeEntry) see the same projected facts. That seam is the whole point —
  # projecting later (override loop only) would recreate the #4177 trap where
  # selection claims on a fact a later stage refuses. All logic lives in the
  # new `src/codegen/ir-abi-signature-projection.ts` module.
  - src/codegen/index.ts
func-budget-allow:
  # +2 lines in `planIrOverlay` for the same hook — the projection must run
  # between `buildIrOverlayIdentityMaps` and `planIrOverlayByIdentity`, which
  # are both inside this function; there is no other seam that reaches both
  # consumers of the maps.
  - src/codegen/index.ts::planIrOverlay
---

# #4186 — signature-level IR/legacy parity: standalone implicit-any object params

## Problem

Standalone acorn's three entry functions (`parse`, `parseExpressionAt`,
`tokenizer`) demote at the patch-time typeIdx parity guard
(`src/ir/integration.ts` ~2623) on every dogfood run — the exact 3
`[IR-FALLBACK]` diagnostics `tests/issue-1712-standalone.test.ts` asserts away
(`errors: []`, red on main, invisible to required CI because the suite is not
in a CI-visible list).

#4177 fixed the BODY-level version of this split-brain (selection claims on a
lattice fact that from-ast refuses to consume). This is the SIGNATURE-level
sibling: the IR's signature derivation and legacy's `lowerParamType` disagree
about the same parameter, so the two functypes intern to different indices and
the finished IR body is withdrawn.

## Diagnostic evidence (JS2WASM_DEBUG_ABI_PARITY=1, 2026-08-06, main @ 431ea77d5)

The #4174 PR's diagnostic prints both functypes on a parity demotion. This PR
extends it to also name the referenced heap types (an `IR=(ref 465)` vs
`legacy=externref` line is unactionable without knowing what 465 is):

```
parse:             IR=466 ((ref 6), (ref 465)) -> externref
                   legacy=101 ((ref 6), externref) -> externref
parseExpressionAt: IR=467 ((ref 6), f64, (ref 465)) -> externref
                   legacy=102 ((ref 6), f64, externref) -> externref
tokenizer:         IR=466 ((ref 6), (ref 465)) -> externref
                   legacy=104 ((ref 6), externref) -> (ref_null 19)

type 6   = struct AnyString (native string)
type 465 = struct __anon_24 { ecmaVersion: f64 (mut), sourceType: ref_null AnyString (mut) }
type 19  = struct __fnctor_Parser (36 fields, closed fnctor instance struct)
```

Two distinct divergences:

1. **`options` param (all three functions).** The dogfood canary calls
   `parse("1 + 2", { ecmaVersion: 2025, sourceType: "script" })`. Both lanes
   see that call site and draw opposite conclusions:
   - **IR**: the propagate fixpoint's object-literal atom
     (`inferObjectLiteralAtom`, `src/ir/propagate.ts`) types `options` as the
     shape `{ecmaVersion: f64, sourceType: string}` → `IrType.object` →
     `__anon_24` → `(ref 465)` in the functype.
   - **Legacy**: `lowerParamType` (`src/codegen/declarations.ts` ~370) runs the
     same call-site inference, gets the auto-registered `__anon_*` struct, and
     **deliberately refuses it in standalone**:
     > "A call-site object literal is only one observed shape of an untyped JS
     > parameter. In standalone, specialising that parameter to the literal's
     > nominal `__anon_*` struct breaks forwarding chains (`parse(input,
     > options) -> Parser.parse -> new Parser`) as soon as another boundary
     > expects the dynamic carrier. Keep anonymous object arguments externref."
     The guard: `!(ctx.standalone && inferredStructName?.startsWith("__anon_"))`.

   NOTE: the task brief attributed legacy's externref to the #2937
   object-hash-consumer routing. Measured, it is NOT #2937 (that set is
   host-only and the comment at `src/codegen/index.ts:7674` says so) — it is
   this adjacent, equally deliberate standalone `__anon_*` refusal. Same
   conclusion either way: legacy's externref is the semantically-correct baked
   ABI, and the IR must apply the SAME projection.

2. **`tokenizer` result (second divergence, behind the first).** Legacy
   resolves the checker's return type (`Parser` instance, via
   `Parser.tokenizer(...)`) to the closed `(ref_null __fnctor_Parser)` struct;
   the IR lattice types the method-call return `dynamic` → externref. Aligning
   this requires the IR to type fnctor-instance returns (and coerce a
   dynamically-computed return value into the struct), which is #4155/#2660
   territory — out of scope here; see Results for the measured chain.

## Why the parity can never hold today (and why the fix is safe)

For an unannotated param (checker `any`) with a lattice object atom in
standalone, legacy ALWAYS lowers externref (the guard above fires on every
`__anon_*` inference, and inconclusive inference defaults to externref). The
IR always lowers the shape struct. `addFuncType` interns by shape, so the two
can never collide onto one typeIdx ⇒ **every such claim is a guaranteed
patch-time withdrawal**. Projecting the IR's fact to `dynamic` therefore
cannot lose a single committing claim — it can only convert withdrawals into
commits (when the body lowers under a dynamic param, e.g. acorn's forwarders)
or into honest selection-time fallbacks (when the body needed the shape).

## Fix (this PR)

Project the TypeMap **before both consumers**, mirroring #4177's
one-source-of-truth approach at the signature level:

- New `src/codegen/ir-abi-signature-projection.ts`:
  `projectStandaloneImplicitAnyObjectParamFacts(ctx, maps, identityContext)` —
  for every top-level FunctionDeclaration unit, every param position whose
  lattice fact is `kind: "object"` AND whose declaration has no type
  annotation AND whose checker fact is any/unknown (`ctx.oracle.typeFactOf`,
  mirroring legacy's `paramType.flags & Any|Unknown` gate — a JSDoc-typed
  param whose checker type legacy resolves directly is NOT projected), is
  rewritten to the `dynamic` lattice fact. Standalone only (`ctx.standalone`;
  wasi/host lowerParamType has no `__anon_*` refusal, bytes there must not
  move).
- Applied in `planIrOverlay` immediately after `buildIrOverlayIdentityMaps`,
  so selection (move-only gating for dynamic params) and the override map
  (`calleeTypes`, from-ast param types) consume the SAME projected fact.
  Projecting only at the override loop would recreate the #4177 trap:
  selection would claim bodies on shape facts the builder then refuses.
- The `projectedTypeMap`/`unitTypeMap` entry-identity invariant
  (`ir-overlay-identity.ts` ~115) is preserved by substituting the same
  replacement entry object into both maps.
- The enriched `JS2WASM_DEBUG_ABI_PARITY=1` diagnostic (referenced-heap-type
  dump) lands with this PR.

## Acceptance criteria

- [ ] Dogfood errors 3 → ≤1; `parse` + `parseExpressionAt` run their IR
      bodies (fallback-tracking output), each residual explained with the
      measured chain.
- [ ] `tests/issue-1712-standalone.test.ts` green and pinning the exact
      residual set (tripwire, not `[]`-red-forever).
- [ ] Canaries 2,3,4,5; `functionImports: []`.
- [ ] `standaloneDynamic` A/B with order-reversal controls per #3927 §6.
- [ ] No `check:ir-fallbacks` unintended growth (gate is host-lane; verified
      by exit code).

## Results

(to be filled)
