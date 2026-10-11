---
id: 6957
title: "standalone: `Math.random = fn` (any `Math.<modelled method> = …` write) is accepted but every `Math.random()` call and `Math.random` value read still resolves to the builtin — Octane regexp `Wrong checksum.` (seeded RNG never used)"
status: done
completed: 2026-10-10
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: builtins, property-assignment
goal: standalone-gap
related: [874, 4199, 4639, 4565, 2907, 2984]
loc-budget-allow:
  - src/codegen/builtin-value-read.ts
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
import-cycles-allow:
  - largestSccSize: 704 # 2026-10-10 (#6957): new expressions/builtin-static-patched-call.ts joins the codegen SCC like every expressions/ sibling
---

# `Math.<method>` patched by the program is ignored by the static Math lowering

Found by the Octane standalone triage (Session D, 2026-10-10, `c-octane-integ`). `regexp` fails
`Error: Wrong checksum.` on standalone. base.js:120 (`BenchmarkSuite.ResetRNG`) installs a seeded
generator with `Math.random = (function () { var seed = 49734321; return function () {…}; })();`
and regexp.js:66-67 calls `Math.random()`. Whole-benchmark confirmation: routing the seeded generator
through a plain var instead of `Math.random` (`.tmp/patch-regexp-rng.mjs`) makes regexp pass on
standalone (`octane_run(1) -> 1`, teardown ok) — this is the ONLY regexp blocker.

## Minimized (`.tmp/rx1.js`, `.tmp/rx2.js`; node left, standalone right)

```js
Math.random = function () { return 0.25; };
function f() { return Math.random() * 4; }
export function main() { return f(); }          // node 1 — standalone 0.9868… (builtin PRNG)

var r = Math.random;                              // standalone: TypeError "Math.random is not yet implemented in --target standalone"
Math.foo = function () { return 7; }; Math.foo()  // standalone: compile error `__get_builtin` (#1472 refusal)
```

## Root cause (three pieces, all standalone)

1. **Calls**: `compileBuiltinStaticCall` (`src/codegen/expressions/call-builtin-static.ts:575`) routes
   every `Math.<m>(…)` to `compileMathCall` (`src/codegen/expressions/builtins.ts`, `random` arm :3661 →
   `Math_random` kernel from `math-helpers.ts:139`) with no check that the program assigned `Math.<m>`.
2. **Writes land but are never read**: the in-body write compiles through the namespace carrier
   (`emitBuiltinNamespaceObject`, `builtin-static-globals.ts:469`, wat `__builtin_Math_obj_*` →
   `__defineProperty_value`/`__paset`), which is seeded with every `BUILTIN_STATIC_METHOD_ARITY.Math`
   method as an own data property (writable). So after the write the carrier's `random` IS the user
   function — the static call arm just never consults the carrier. (#4199 deliberately drops a TOP-LEVEL
   `Math.random = …` for the same "reader never consults the bag" reason — `builtin-write-keeps.ts`.)
3. **Value read**: `property-access-dispatch` → `builtin-value-read.ts:1788` throws the
   "not yet implemented" TypeError for `Math.random` as a value (`emitMathValueReadBody` has no
   `random` kernel); `tryEmitBuiltinStaticExpandoRead` (`builtin-static-expando.ts:98`) refuses any
   name in `BUILTIN_STATIC_METHOD_ARITY` by design ("absent-not-wrong").

## Implementation Plan (standalone only; gc byte-identical)

1. **Source-scan predicate** — `src/codegen/source-scan-predicates.ts`: add
   `patchedBuiltinStaticMembers(sourceFile): ReadonlyMap<string /*ns*/, Set<string>>` collecting
   `<Math|JSON|Reflect>.<name> = …`, `op=`, `++/--`, `delete`, and `Math["name"] = …` targets anywhere
   in the file (receiver must be the unshadowed global — reuse the shadow test from
   `builtin-write-keeps.ts`). Cache per `SourceFile` (WeakMap) and expose via `ctx` (one optional field,
   or a module-level WeakMap keyed on ctx as `runtime-eval-construct.ts` does).
2. **Call arm** — `call-builtin-static.ts:575`: when `ctx.standalone && patched.get("Math")?.has(name)`
   (and `isGlobalBuiltinIdentifier(ctx, fctx, propAccess.expression)`), bypass `compileMathCall` and emit
   the dynamic call: `emitBuiltinNamespaceObject(ctx, fctx, "Math")` → `local.set obj`;
   `obj` + key → `__extern_get` (same `ensureLateImport("__extern_get")` + `stringConstantExternrefInstrs`
   as `tryEmitBuiltinStaticExpandoRead`); then the `__apply_closure(callee, thisArg=obj, argsVec)` pattern
   of `tryCompileImmutablePropertyCallableAlias` (`call-identifier.ts:401-470`: `reserveApplyClosure`,
   `ensureObjVecBuilders`, push each arg via `emitExternValue`). Result `externref`. Because the carrier is
   seeded with the builtin closure for every modelled method, an unpatched-at-runtime read still calls the
   builtin — no ordering hazard if the override is installed later or conditionally.
3. **Value read** — `builtin-value-read.ts` `emitMathValueReadBody`: add the `random` kernel (the
   standalone `Math_random` from `math-helpers.ts:139`) so `var r = Math.random` works, and in
   `tryEmitBuiltinStaticExpandoRead` relax the `BUILTIN_STATIC_METHOD_ARITY` refusal when the member is in
   the patched set (the carrier then holds the user's value or the seeded builtin).
4. **Top-level write keep** — `builtin-write-keeps.ts` `shouldKeepBuiltinReceiverWrite`: keep a top-level
   `Math.<modelled method> = …` when the member is patched (it now has a reader); `MATH_CONSTANTS` stay dropped.
5. Order: 1 → 2 → 3 → 4; each independently testable. The gate-sensitive file is
   `call-builtin-static.ts` (LOC budget) — the dynamic-call emission should be a ~40-line helper in a new
   `src/codegen/expressions/builtin-static-patched-call.ts`.

### Edge cases
- `Math.random` called BEFORE the override: carrier seeded with the builtin → correct.
- Override inside a function (regexp's case) vs top level (step 4): both land on the same carrier.
- A local variable named `Math` shadows: predicate and arm decline (shadow test).
- `JSON.stringify = …`/`Reflect.*`: same mechanism applies; keep scope to `Math` unless trivially shared.
- gc/host lane: untouched (`ctx.standalone` gate) — host already honours the write via `__extern_set`? It does
  NOT for the call arm either; file a host follow-up only if the lane is kept.

### Acceptance
- `tests/issue-<id>.test.ts` standalone: `.tmp/rx1.js` → `1`; `.tmp/rx2.js` → `111`; override installed in a
  function then called from another → user value; call before override → number in [0,1); control: no
  write in the program → `compileMathCall` bytes unchanged (hash a fixture).
- `pnpm run -s benchmark:octane -- --only regexp --lanes standalone --timeout 300` → pass (also needs the
  harness Script-goal flag, #6937 step 4; measured: regexp compiles in ~32 s).
- Size: **M**.

## Implementation notes (2026-10-10)

- **Predicate** — `isPatchedBuiltinStaticMember(ctx, ns, name)` (`source-scan-predicates.ts`)
  scans every `ctx.callableSourceFiles` entry once (WeakMap per `SourceFile`) for writes to
  `Math|JSON|Reflect.<name>` (`=`, compound, `++/--`, `delete`, literal-key element form). It
  returns false outside standalone, so the gc lane and the #3437 harness compile-work budget
  (a gc compile) never pay the walk. Scanning the whole source set (not the call site's file)
  keeps multi-module programs correct.
- **Call arm** — `expressions/builtin-static-patched-call.ts`, hooked at the `Math` arm of
  `compileBuiltinStaticCall`: carrier (`emitBuiltinNamespaceObject`) → `__extern_get(carrier,
  name)` → `__apply_closure(callee, this = Math, argsVec)`. Spread arguments decline to the
  static lowering.
- **Shadow test deviation** — the arm cannot use `isGlobalBuiltinIdentifier`: a top-level
  `Math.random = fn` in a JS file makes TypeScript append the `Math` identifier to the lib
  symbol's declarations, so that helper reads `Math` as user-declared exactly in the program
  this fix is for. The arm filters those synthetic receiver declarations
  (`isSyntheticPropertyAssignmentReceiverDeclaration`, now exported from `builtin-write-keeps.ts`).
- **Value read** — `ensureStandaloneBuiltinStaticMethodClosure` declines for a patched member
  only when called from the source read site (the one caller that passes `expr`), so the read
  falls to `tryEmitBuiltinStaticExpandoRead`, whose static-method refusal is relaxed for patched
  members. The carrier seeding still gets the closure.
- **`Math.random` kernel** — the value closure gets the `Math_random` kernel (`() -> f64`) ONLY
  in programs that patch `Math.random`; every other program keeps the generic throw body, so it
  compiles byte-identically (the kernel would otherwise change every program that materializes
  the Math carrier). Ungating it is a one-line follow-up if `var r = Math.random` in unpatched
  programs is wanted.
- **Top-level keep** — `isBuiltinNamespaceExpandoWriteTarget` keeps a top-level
  `Math.<modelled method> = …` (the write now has a reader); constants stay dropped.

### Pre-existing defects found (not fixed here, reproduce on base)
- `Math.max = function (a, b) {…}` (top level or in a body) → `Binary emit error: RangeError:
  Invalid array length` on standalone (contextual typing from the variadic lib signature).
- `function g() { var Math = { random() { return 3; } }; return Math.random(); }` returns the
  builtin PRNG: the `Math` arm of `compileBuiltinStaticCall` calls `compileMathCall` with no
  shadow check.
- Unverified (blocked by the `Math.max` crash above): a plain alias of a patched variadic
  static (`var m = Math.max; m(…)`) may still route through `builtin-static-plain-alias.ts`'s
  static closure ABI rather than the carrier.
