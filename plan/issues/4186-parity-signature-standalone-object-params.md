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
  # +64: the (#4186) containment — selection-time rejection of claimed bodies
  # that pass an object literal into a dynamic callee param (from-ast cannot
  # box those; under IR-first the build failure is a HARD compile error with
  # no binary, measured pre-existing on main). It must live in select.ts: it
  # reuses `calleeParamResolvedKind`/`calleeHasAnyDynamicParam`/`shapeNo`,
  # which are module-local by design ("threading a param through the shared
  # isPhase1* recursion would conflict with every in-flight selector slice"),
  # and the check belongs with the other claim gates it extends.
  - src/ir/select.ts
func-budget-allow:
  # +2 lines in `planIrOverlay` for the same hook — the projection must run
  # between `buildIrOverlayIdentityMaps` and `planIrOverlayByIdentity`, which
  # are both inside this function; there is no other seam that reaches both
  # consumers of the maps.
  - src/codegen/index.ts::planIrOverlay
  # +21: the JS2WASM_DEBUG_ABI_PARITY heap-type dump — the parity guard sits
  # inside this (already-oversized, #3399) function, and both typeIdx values
  # plus ctx.mod.types are only in scope there at the demotion decision.
  # Splitting the function is a separate refactor that should not ride along.
  - src/ir/integration.ts::compileIrPathFunctions
  # +19: the (#4186) containment check — a claimed body passing an object
  # literal into a dynamic callee param must be rejected BEFORE the claim
  # (from-ast cannot box it; under IR-first the build failure is a hard
  # compile error with no binary). The check has to sit with the other
  # claim-gates in this function (same `calleeParamResolvedKind`/`shapeNo`
  # machinery, same never-claim-then-demote contract); the walker itself
  # lives in a separate helper below the function.
  - src/ir/select.ts::whyNotIrClaimable
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

## Suspended Work (2026-08-07)

**Status: INCOMPLETE. The projection module and its behavioural test exist; the
wiring that makes either of them do anything DOES NOT.** Recorded here verbatim
because the worktree that held it is ephemeral and the work is non-trivial.

### What is on the branch (committed, safe)

- The issue file itself (problem statement + captured functype pairs).
- `src/ir/integration.ts` +21 — the enriched `JS2WASM_DEBUG_ABI_PARITY` heap-type
  dump at the demotion decision. Self-contained; useful on its own.

### What is MISSING — and why this is the interesting part

The frontmatter already carries budget grants for edits that are **not in the
tree**:

| grant | edit | present? |
| --- | --- | --- |
| `src/codegen/index.ts::planIrOverlay` +2 | the projection hook itself | **NO** |
| `src/ir/select.ts` +64 | selection-time containment | **NO** |
| `src/ir/integration.ts::compileIrPathFunctions` +21 | parity dump | yes |

Grants written for edits that are absent is the signature of an **A/B revert
that was never restored** — the CLAUDE.md file-copy A/B cycle (`cp .tmp/new.ts
src/foo.ts` to restore) with the restore step missed. Anyone resuming should
assume the design is sound and the code was lost, not that the design was
abandoned.

The hook seam is precisely specified by the grant comment: the projection must
run **between `buildIrOverlayIdentityMaps` and `planIrOverlayByIdentity`**,
both inside `planIrOverlay`, because that is the only seam reaching *both*
consumers of the identity maps. Projecting at the override loop alone
recreates the #4177 trap (selection claims a body on a shape fact the builder
then refuses — a hard failure under IR-first, not a fallback).

### Do NOT trust the test edit that was reverted out

The WIP also changed `tests/issue-1712-standalone.test.ts` from
`expect(report.errors).toEqual([])` to expecting exactly **one** residual
(`tokenizer`), on the premise that the projection fixed `parse` and
`parseExpressionAt`. **With the wiring absent that assertion is false** — the
module is imported by nothing, so behaviour is identical to `main` and all
three demotions remain. The edit was reverted for that reason. Re-apply it only
after the hook lands and the 3 → 1 drop is measured, not assumed.

Worth knowing regardless: **that test is red on `main` today**, asserting `[]`
against three `function typeIdx parity mismatch` fallbacks. It is not in any
required-check list, so nothing surfaces it at PR time; the post-merge
`issue-tests.yml` detector sees it and its known-failure baseline absorbs it.

### The two source files, preserved verbatim

`src/codegen/ir-abi-signature-projection.ts` (110 lines) and
`tests/issue-4186-signature-parity-projection.test.ts` (95 lines) are NOT
committed as source — an unwired module trips `check:dead-exports`, and dead
code on `main` is worse than a documented rescue. They were **untracked**, which
means git holds no copy of them at all and the ephemeral worktree was their only
home, so both are inlined verbatim at the end of this section. Restore by
copying them back out.

The projection's contract, in its own words:

> The propagate fixpoint types an implicit-`any` parameter from a call-site
> object literal as a structural shape (`__anon_N` struct in the functype),
> while the legacy lane's `lowerParamType` runs the SAME call-site inference and
> then DELIBERATELY refuses the `__anon_*` specialisation in standalone — "a
> call-site object literal is only one observed shape of an untyped JS
> parameter … keep anonymous object arguments externref."
>
> `addFuncType` dedups by shape, so the two functypes can never land on one
> typeIdx, and every such claim is a GUARANTEED patch-time "function typeIdx
> parity mismatch" withdrawal: the IR body is built, lowered, then thrown away.
> Measured on standalone acorn: `parse`, `parseExpressionAt` and `tokenizer`
> demote this way on every dogfood run.
>
> The projection rewrites the lattice fact to `dynamic` BEFORE both consumers.
> Safety: it fires only where legacy is KNOWN to intern externref, so the
> pre-projection state for every affected function was a guaranteed withdrawal.
> Post-projection outcomes are either a commit or an honest selection-time
> fallback — both strictly better than building and discarding the body.

### Resume checklist

1. Re-create the projection module from the contract above.
2. Add the +2-line hook in `planIrOverlay` at the stated seam.
3. Run the standalone dogfood; confirm the IR-FALLBACK count drops 3 → 1 with
   `tokenizer` the residual (return-position divergence, out of scope here).
4. Only then update `tests/issue-1712-standalone.test.ts` to pin the residual.
5. Re-check whether the `src/ir/select.ts` containment (+64) is still needed, or
   whether the seam change alone suffices — the grant may over-provision.

### Verbatim: `src/codegen/ir-abi-signature-projection.ts`

```ts
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4186) SIGNATURE-level IR/legacy ABI parity projection.
//
// #4177 aligned BODY-level provability (selection claiming on a lattice fact
// from-ast refused to consume). This module is the signature-level sibling:
// the propagate fixpoint types an implicit-`any` parameter from a call-site
// object literal as a structural shape (`{ecmaVersion: f64, sourceType:
// string}` → `IrType.object` → an `__anon_N` struct in the functype), while
// the legacy lane's `lowerParamType` (src/codegen/declarations.ts) runs the
// SAME call-site inference and then DELIBERATELY refuses the `__anon_*`
// specialisation in standalone:
//
//   "A call-site object literal is only one observed shape of an untyped JS
//    parameter. In standalone, specialising that parameter to the literal's
//    nominal `__anon_*` struct breaks forwarding chains (`parse(input,
//    options) -> Parser.parse -> new Parser`) as soon as another boundary
//    expects the dynamic carrier. Keep anonymous object arguments externref."
//
// So for this exact population — standalone, parameter without a type
// annotation, checker fact any/unknown, lattice fact `object` — legacy ALWAYS
// interns externref while the IR always interns a shape struct. `addFuncType`
// dedups by shape, so the two functypes can never land on one typeIdx and
// every such claim is a GUARANTEED patch-time "function typeIdx parity
// mismatch" withdrawal (src/ir/integration.ts): the IR body is built, lowered,
// and then thrown away. Measured on standalone acorn: `parse`,
// `parseExpressionAt` and `tokenizer` demote this way on every dogfood run.
//
// The projection rewrites the lattice fact to `dynamic` BEFORE both consumers
// — selection (`planIrOverlayByIdentity`, which gates dynamic params on the
// move-only body scan) and the override map (`calleeTypes` / from-ast param
// types, built from the same `typeEntry` rows). Projecting at the override
// loop alone would recreate the #4177 trap: selection would claim a body on a
// shape fact the builder then refuses (a hard fail under IR-first, not a
// fallback). One projection at the map seam keeps every stage on one source
// of truth, mirroring legacy's own decision.
//
// Safety argument (why this cannot lose a committing claim): the projection
// fires only where legacy is KNOWN to intern externref (the gate below is a
// faithful mirror of `lowerParamType`'s implicit-any arm + standalone
// `__anon_*` refusal), so the pre-projection state for every affected
// function was a guaranteed withdrawal. Post-projection outcomes are either
// a commit (body lowers under the dynamic param — acorn's forwarders) or an
// honest selection-time fallback (body needed the shape) — both strictly
// better than building and discarding the body. Host/wasi lanes are
// untouched: `lowerParamType` has no `__anon_*` refusal there, and in host
// mode the IR's `ObjectStructRegistry` dedups onto the same `__anon_N` the
// legacy inference registers, so parity already holds.

import { ts } from "../ts-api.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { LatticeType, TypeMapEntry } from "../ir/propagate.js";
import type { IrOverlayIdentityMaps } from "./ir-overlay-identity.js";
import type { CodegenContext } from "./context/types.js";

const DYNAMIC: LatticeType = { kind: "dynamic" };

/**
 * Mirror of the legacy gate under which `lowerParamType` refuses a
 * call-site-inferred `__anon_*` struct and keeps the parameter externref:
 * standalone target, no type annotation, identifier name (binding patterns
 * widen before inference), checker fact any/unknown (a JSDoc-typed parameter
 * resolves through `resolveWasmType` directly and KEEPS its struct — such a
 * parameter must not be projected).
 */
function legacyRefusesObjectSpecialisation(ctx: CodegenContext, parameter: ts.ParameterDeclaration): boolean {
  if (parameter.type || parameter.dotDotDotToken) return false;
  if (!ts.isIdentifier(parameter.name)) return false;
  const fact = ctx.oracle.typeFactOf(parameter);
  return fact.kind === "any" || fact.kind === "unknown";
}

/**
 * (#4186) Project standalone implicit-`any` object-atom parameter facts to
 * `dynamic`, so the IR's derived signature matches the ABI the legacy lane
 * bakes into every already-compiled caller. Returns the input maps unchanged
 * (same object identity) when nothing needs projecting; otherwise returns new
 * maps in which every rewritten `TypeMapEntry` is substituted by the SAME
 * replacement object in both `unitTypeMap` and `projectedTypeMap` — the
 * entry-identity invariant checked by `planIrOverlayByIdentity` must survive.
 */
export function projectStandaloneImplicitAnyObjectParamFacts(
  ctx: CodegenContext,
  maps: IrOverlayIdentityMaps,
  identityContext: IrPlanningIdentityContext,
): IrOverlayIdentityMaps {
  if (!ctx.standalone) return maps;
  const replacements = new Map<TypeMapEntry, TypeMapEntry>();
  for (const [unitId, entry] of maps.unitTypeMap) {
    const declaration = identityContext.declarationByUnitId.get(unitId);
    if (!declaration || !ts.isFunctionDeclaration(declaration)) continue;
    let projected: LatticeType[] | null = null;
    for (let i = 0; i < entry.params.length; i++) {
      if (entry.params[i]!.kind !== "object") continue;
      const parameter = declaration.parameters[i];
      if (!parameter || !legacyRefusesObjectSpecialisation(ctx, parameter)) continue;
      projected ??= [...entry.params];
      projected[i] = DYNAMIC;
    }
    if (projected) replacements.set(entry, { params: projected, returnType: entry.returnType });
  }
  if (replacements.size === 0) return maps;
  const unitTypeMap = new Map(
    [...maps.unitTypeMap].map(([unitId, entry]) => [unitId, replacements.get(entry) ?? entry] as const),
  );
  const projectedTypeMap = new Map(
    [...maps.projectedTypeMap].map(([name, entry]) => [name, replacements.get(entry) ?? entry] as const),
  );
  return { unitTypeMap, projectedTypeMap };
}
```

### Verbatim: `tests/issue-4186-signature-parity-projection.test.ts`

```ts
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4186 — signature-level IR/legacy ABI parity for standalone implicit-any
 * object-fact parameters.
 *
 * Two invariants, both measured broken on main @ 431ea77d5 before the fix:
 *
 * 1. THE PROJECTION. The propagate fixpoint types an implicit-`any` param
 *    from a call-site object literal as a shape struct (`__anon_N`), while
 *    legacy's `lowerParamType` deliberately refuses that specialisation in
 *    standalone and keeps externref. `addFuncType` interns by shape, so the
 *    two functypes can never collide and every such claim was a guaranteed
 *    patch-time "function typeIdx parity mismatch" withdrawal — the exact 3
 *    IR-FALLBACK errors of the acorn dogfood (`parse`, `parseExpressionAt`,
 *    `tokenizer`). The #4186 projection rewrites those lattice facts to
 *    `dynamic` before selection AND the override map, so the IR signature
 *    equals the legacy ABI and the body commits.
 *
 * 2. THE CONTAINMENT. from-ast cannot box an object literal into a
 *    dynamic-typed position (`boxConcreteToDynamic` is scalar/string-only),
 *    so a claimed caller passing a literal into a dynamic callee param
 *    hard-failed the WHOLE compile under IR-first ("Codegen error: … arg 0 of
 *    call to f is object{a:f64}, expected dynamic", no binary) — pre-existing
 *    on main with `f(x: any)`, and made common by the projection. Selection
 *    now rejects such bodies up front (soft body-shape fallback, binary
 *    still produced).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const messageOf = (e: unknown): string => {
  if (typeof e === "string") return e;
  const m = (e as { messageText?: unknown; message?: unknown }).messageText ?? (e as { message?: unknown }).message;
  return typeof m === "string" ? m : JSON.stringify(m);
};

describe("#4186 — standalone signature-parity projection for implicit-any object params", () => {
  it("commits the IR body for the acorn forwarder shape instead of demoting on typeIdx parity", async () => {
    // Minimal acorn shape: `top(options)` forwards an untyped options object
    // into a helper; `drive` supplies the object literal. Pre-fix: `seek` and
    // `top` were claimed with a shape-struct param, built, lowered, and then
    // withdrawn on "function typeIdx parity mismatch" (legacy interned
    // externref); `drive` withdrew on the #3551 cascade.
    const source = `
function seek(options, k: number): number {
  return k;
}
export function top(options): number {
  return seek(options, 41) + 1;
}
export function drive(): number {
  return top({ ecmaVersion: 2025, sourceType: "script" });
}
`;
    const result = await compile(source, {
      fileName: "issue-4186-projection.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    const errors = (result.errors ?? []).map(messageOf);
    expect(errors.filter((m) => m.includes("typeIdx parity mismatch"))).toEqual([]);
    expect(errors).toEqual([]);

    // The IR bodies must actually COMMIT — the pre-fix failure mode was
    // "claimed, built, withdrawn", which also had zero committed IR bodies.
    const emitted = (result.irOutcomes ?? []).filter((o) => o.kind === "emitted").map((o) => o.displayName);
    expect(emitted).toContain("seek");
    expect(emitted).toContain("top");

    // Execution: the projected-dynamic param must still flow end to end.
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary!), {});
    expect((instance.exports.drive as () => number)()).toBe(42);
  });

  it("rejects (softly) a claimed caller passing an object literal into a dynamic param instead of hard-failing the compile", async () => {
    // Pre-fix on main this was a HARD compile failure with NO binary:
    // "Codegen error: IR path failed for g: ir/from-ast: arg 0 of call to f
    //  is object{a:f64}, expected dynamic in g [IR-FALLBACK]".
    const source = `
function f(x: any): number { return 1; }
export function g(): number { return f({ a: 1 }); }
`;
    const result = await compile(source, {
      fileName: "issue-4186-containment.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    const errors = (result.errors ?? []).map(messageOf);
    expect(errors.filter((m) => m.startsWith("Codegen error"))).toEqual([]);
    expect(result.binary?.length ?? 0).toBeGreaterThan(0);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary!), {});
    expect((instance.exports.g as () => number)()).toBe(1);
  });
});
```
