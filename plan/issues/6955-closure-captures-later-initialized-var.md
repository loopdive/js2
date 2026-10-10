---
id: 6955
title: "Closure captures a `var` BY VALUE when the var's initializer runs AFTER the closure is created (hoisted `var dt = 0.1` at the end of a constructor) — captured value is the uninitialized default (Octane navier-stokes: every field NaN, checksum 0)"
status: ready
sprint: current
created: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: closures, var-hoisting
goal: standalone-gap
related: [874, 6937, 1177, 996]
---

# Closure capture-by-value of a var initialized after the closure

Found by the Octane standalone triage (Session D, 2026-10-10, branch `c-octane-integ`).
`navier-stokes` is the only benchmark this blocks; with the harness Script-goal flag
(#6937 step 4) it reaches frame 15 and fails `checksum failed` with `this.result == 0`
because every `u`/`v`/`dens` cell is `NaN` after the first `vel_step` (stage probe
`.tmp/patch-ns-vel.mjs`: `addFields(u, u0, dt)` turns all 16,900 cells NaN; `dt` is NaN).

## Minimized repro (`.tmp/ns7.js`, node `0.2`, standalone `NaN`)

```js
function FF() {
  this.get = function () { return dt * 2; };
  var dt = 0.1;                       // hoisted: slot exists, initializer runs AFTER the closure above is built
}
/** @returns {number} */
export function main() { return new FF().get(); }
```

Octane shape: `FluidField` defines `this.update = function () { … vel_step(u, v, u_prev, v_prev, dt); … }`
(navier-stokes.js:348) and only afterwards declares `var iterations = 10; var visc = 0.5; var dt = 0.1;`
(:360-362). Whole-benchmark confirmation: hoisting those three declarations above the closures
(`.tmp/patch-ns-hoist.mjs`) makes navier-stokes pass 16 frames on standalone (`octane_run(16) -> 16`,
teardown ok). Same result with and without `inferModuleStrictArguments: false`.

## Root cause

`planClosureCaptures` (`src/codegen/closures/arrow-phases.ts` ~L905-928) boxes a capture only when
`writtenInClosure || writtenInOuter || hasTdzFlag || initializerStoreFollowsCapture`.
`dt` is never *assigned* (the initializer is a declaration, so `collectOuterWrites` L700-780 does not
see it), `var` has no TDZ flag (#1177 covers `let`/`const` only), and
`closurePrecedesBindingInitializerStore` (L534-550) answers true ONLY when the closure sits *inside*
the declarator's initializer. So the capture is by value: the closure struct snapshots the local's
default (f64 `0`/NaN-undefined) at construction and never sees the later store.

## Implementation Plan

1. **`src/codegen/closures/arrow-phases.ts`, `closurePrecedesBindingInitializerStore` (L534)** — add
   the second textual case: the declaration is a `var` `VariableDeclaration` WITH an initializer,
   `declaration.pos >= closure.end` (declarator textually after the closure), and both share the
   nearest enclosing function-like (walk `closure.parent` and `declaration.parent` up to the first
   `ts.isFunctionLike` / `SourceFile`; they must be the same node — same Wasm frame, same slot). Return
   `true` → `isMutable` → the capture is boxed; the later initializer store goes through the ref
   cell because the var is in `fctx.boxedCaptures` by the time `var dt = 0.1` compiles
   (`eagerDominatingBox` / `canBoxBindingInDominatingParent` handle the pre-box, same as #996).
   `let`/`const` after the closure already take the `hasTdzFlag` arm — leave them alone.
2. The same predicate is consulted at `src/codegen/closures.ts:4444` (second caller) — no change
   needed there beyond the shared helper.
3. **Do NOT** add the declaration to `writtenInOuter`: that set also drives the "writes in outer
   scope" diagnostics; the capture-mutability bit is the only thing that must flip.

### Edge cases
- `var x = 1` after the closure but inside a nested block/loop: same frame → still boxed (safe, slightly slower).
- Declaration without initializer after the closure: unchanged (value only changes via assignments, already covered).
- Closure inside a *different* function than the declaration (nested function body): unchanged (`ts.isFunctionLike` stop, existing rule).
- Inlined IIFE boundaries (`fctx.inlinedIifeNodes`): treat an inlined IIFE as transparent exactly as `collectOuterWrites` does (L700-715).

### Acceptance
- `tests/issue-<id>.test.ts` (public `compile()`, `allowJs`, `target: "standalone"` and gc): `.tmp/ns7.js` → `0.2`;
  variant with two closures reading `dt` before/after; control `var dt = 0.1` BEFORE the closure (byte-identical).
- `pnpm run -s benchmark:octane -- --only navier-stokes --lanes standalone --timeout 300` → pass (requires the
  harness to pass `inferModuleStrictArguments: false`, #6937 step 4 — otherwise `checkResult`'s sloppy `this` fails first).
- Size: **S** (one predicate, ~15 lines).

## Ownership / overlap
`src/codegen/closures/arrow-phases.ts` — not touched by #6949/#6950/#6951.
