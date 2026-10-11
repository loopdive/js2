---
id: 6720
title: "standalone: lodash-es module-init throws `Cannot access property on null or undefined at 10:22` (regression on main after #6175)"
status: done
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
completed: 2026-09-28
loc-budget-allow:
  # 2026-09-28 (#6720): +11 lines — one import, the snapshot-construct arm in
  # compileNewExpression and one retry line at each of the two dynamic-`new`
  # chains. The mechanism itself lives in the new builtin-collection-dyn-construct.ts.
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # 2026-09-28 (#6720): one call line each — the retry/arm wiring; the arm
  # bodies are in builtin-collection-dyn-construct.ts.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6684, 6704, 6690, 6711, 6737, 6738]
---

# #6720 — lodash-es standalone module-init regression on main

## Problem

The lodash-es npm-compat `standalone-dynamic` lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only lodash-es --no-write
--perf-only --lane standalone-dynamic`) now stops at module init, verbatim:

```
status: runtime-error   phase: module-init
TypeError: Cannot access property on null or undefined at 10:22
```

## Measured

| code | lane result |
|---|---|
| `c2601efa89` + PR #6175 (#6684) branch + #6704 fix | `measured`, checksum 54 = 54 |
| main `37b11b2891` (#6175 merged), `calls-closures.ts` exactly as on main (no #6704 change) | the module-init TypeError above |
| main `37b11b2891` + #6704 fix | the same module-init TypeError |
| main `f2e06e1224` + #6704 fix | the same module-init TypeError |

So it is not caused by #6704. It reproduces on main's own code and was
introduced between `c2601efa89` and `37b11b2891`. Other merges in that range
(`git log --first-parent c2601efa89..37b11b2891`): #6154 (#6690 standalone map
union callback), #6208 (`issue-lodash-next-standalone`), #6209. Not bisected.

The smaller `package/string.js` barrel graph (`words` + `kebabCase` through the
barrel, ~25 s compile) initializes and answers correctly on the same code, so
the failing module is outside that barrel's closure.

## Acceptance

- The lane gets past module-init again (back to the #6704 state: `measured`,
  checksum 54 = 54).
- A regression test pins the failing module-init shape.

## Implementation Plan

Executed.

1. **Bisect** the lodash-es lane over the first-parent merges between
   `c2601efa89` and `37b11b2891`, using a 30 s reduction of the lane instead of
   the 10-17 min full graph: `array.default.js`'s imports 48-56 (`takeWhile`
   … `unzip`) from a copy of the package, compiled with the lane's options.
   | merge | reduction |
   |---|---|
   | `e2f26c85a2` (#6175) | module init OK |
   | `390f7f5dc3` (#6208) | `TypeError: … at 10:22` |
   Culprit: **#6208** (#6711, `standalone-global-object-carriers.ts`), which
   seeds `globalThis.Map/Set/WeakMap/WeakSet/…` when no runtime-eval provider
   is linked. #6154 and #6209 are not involved.
2. **Mechanism.** `10:22` is `_setToArray.js`, `Array(set.size)`, reached
   from `_createSet.js`: `Set && (1 / setToArray(new Set([,-0]))[1]) == INFINITY`.
   Before #6208 lodash's `getNative(root, 'Set')` answered `undefined` and the
   `Set &&` short-circuited. With the seed it answers the `__builtin_ctor_Set`
   carrier, and `new Set(…)` — `Set` being the **imported default-expression
   snapshot** `export default Set` of `_Set.js` — hit the host-free refusal in
   `compileNewExpression` ("Constructing an imported default-expression snapshot
   is not available without a host"), which evaluated to null (the diagnostic
   does not surface; the compile still succeeds). Independently, even a direct
   `new S(…)` on an any-typed value holding a collection carrier answered null:
   no dynamic-`new` arm constructs a `Map`/`Set`/`WeakMap`/`WeakSet` carrier.
3. **Fix forward, keeping #6208's seed.**
   - `src/codegen/builtin-collection-dyn-construct.ts` (new):
     `__builtin_collection_dyn_construct(callee, arg0)` compares the callee by
     identity against each collection carrier global the module reserved and
     builds the real branded `$Map` through the existing #3972
     `__new_<Name>@<n>` constructors. Any other callee answers null (the old
     outcome). Reserve-then-fill; the per-collection constructors are
     registered mid-compile (site reservation, or the carrier's reservation via
     a one-line hook in `reserveBuiltinConstructorIdentityGlobal`).
   - Wired as: an arm in every `__native_construct_<N>` driver (before the
     IsConstructor guard); a null-retry after the TA-construct chain in both
     host-free dynamic-`new` chains (`compileNewExpression`'s class-free arm and
     `emitDynamicNewFallback`'s no-match base).
   - `compileNewExpression`: in the host-free lane a default-expression-import
     callee now constructs its snapshot VALUE through
     `tryCompileNativeConstructFromValue` (admitted there) instead of the
     refusal; the refusal stays for a shape that arm declines.
4. **Tests** `tests/issue-6720-collection-ctor-value-construct.test.ts`: the
   culprit's realm-idiom shape (`Function('return this')().Set` etc.,
   `runtimeEvalProvider: false`) and lodash-es's module graph in miniature
   (`_root`/`_getNative`/`_Set`/`_setToArray`/`_createSet`), both against Node.

## Resolution

Culprit **#6208** (#6711): its realm-constructor seed is correct and kept; it
exposed that host-free `new` could not construct a collection constructor held
in a value, nor an imported default-expression snapshot at all. Both now
construct.

- Lane `lodash-es` `standalone-dynamic`: before `runtime-error` at
  `module-init` (`TypeError: Cannot access property on null or undefined at
  10:22`) → after **`measured`, checksum 54 = 54** (compile 1,026 s on a box at
  load ~150).
- Regression test: parent 0/2 (row 1 `29992` vs `11111`, row 2 throws at module
  init) → fix 2/2.
- JS-host is byte-identical: every entry point is gated on `noJsHost`.

Next blocker (from #6704, still true): CI runs this lane in a child with a
120 s compile budget; the compile takes 10-17 min here. Profiled and filed as
[#6737](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6737-lodash-es-compile-time-census-assert-quadratic):
61 % of compile time is `assertMultiPreparedModuleInitCensusCurrent`, a
whole-program check run once per module.

Residual, not fixed here: `new (a || B)()` (a non-identifier callee
expression) still answers null in the host-free lane, before and after —
lodash's `new (Map || ListCache)` in `_mapCacheClear.js` / `_stackSet.js`
reaches it at run time (not on the `words`/`kebabCase` path). Filed as
[#6738](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6738-standalone-new-of-logical-or-callee-null).
