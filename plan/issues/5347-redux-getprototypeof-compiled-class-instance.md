---
id: 5347
title: "Object.getPrototypeOf on a COMPILED class instance answers Object.prototype — redux isAction 0/1, plus the `vm` gap and a compiler hang, from #5325's residuals"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

#5325 fixed `Object.getPrototypeOf` for the WasmGC **builtin** carriers (Date,
Array, …) when the receiver arrives as a parameter, and moved redux 60 → 64.
Its measured residuals, none fixed there:

1. **Compiled class instance → `Object.prototype`.** `isPlainObject(new (class
   A { type = 'x' }))` still answers `true` because `getPrototypeOf(<compiled
   struct>)` cannot see the class's prototype object — it needs a
   **codegen-side discriminator** mapping the struct's type index to its
   class prototype carrier, which the host-side `__getPrototypeOf` import
   (`src/runtime.ts` ~13920) does not have. `redux test/utils/isAction.spec.ts`
   is 0/1 on exactly this.
2. **`import vm from 'vm'` is unmodelled.** `vm.runInNewContext(...)` is a
   silent no-op; `isPlainObject.spec.ts` asserts the cross-realm case first
   and is 0/1 regardless of (1). This is a host-shim gap and almost certainly
   **wont-fix** for the compiler — record the verdict, do not implement `vm`.
3. **`Object.setPrototypeOf` on an array literal** never reaches
   `__host_set_struct_proto`; the query answers `Array.prototype` instead of
   the assigned prototype. Pinned as a residual in #5325's test.
4. **A compiler hang** (>900 s) on a `getPrototypeOf` chain-walk written
   inline in a test-body arrow; the same walk in an imported `.mjs` compiles
   in ~7 s. Reproducible, not chased.

Separately, redux is at **61/82** on clean main — down 3 from #5325's
post-merge 64 via `combineReducers` identity failures. That regression is
being bisected under its own dispatch; **do not attribute it here**.

## Acceptance criteria

1. `getPrototypeOf(new C())` for a compiled class `C` answers `C.prototype`
   (identity-equal to the class object's `.prototype` carrier); `isAction`
   0/1 → 1/1.
2. Regression test failing on parent, passing with fix, untyped `.js`
   two-file fixtures; includes the #5325 builtin cases as a no-regression
   control and the `setPrototypeOf`-on-array residual pinned (flip it if you
   fix it).
3. Verdict on (2) recorded in this file with the evidence; (4) reproduced
   once with the source shape and timing recorded, or re-filed.
4. A/B at one HEAD, 17 suites, per test file (anchors in #5338; redux
   anchor is **61/82**).
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Read #5325's fix in `src/runtime.ts` (`__getPrototypeOf`, the
   `isDataStruct` branch) and `src/codegen/class-proto-object.ts` — the
   compiler already mints a per-class prototype carrier for `C.prototype`
   reads and `instanceof`. The missing piece is the **reverse map** at the
   host boundary: given a wrapped struct, which class minted it.
2. Two viable designs; pick by measurement: (a) the host import consults a
   struct-type-index → prototype-carrier table exported from the module
   (there is precedent in `buildShapePropFlagsTable` / `__member_kind_<key>`
   sidecars); (b) `__getPrototypeOf` on a data struct calls back into a
   compiled `__proto_of_struct` dispatcher that `ref.test`s per class — the
   closed-dispatch pattern in `closed-method-dispatch.ts`. (b) is
   standalone-friendly; (a) is cheaper. Check `dynamic-proto.ts` first —
   part of this may exist for `__proto__` reads.
3. Reduce with a negative control; WAT; fix; regression test.
4. Record the `vm` verdict and the hang repro in this file.
5. A/B; one PR.

## Dispatch

Model: **opus**. Requires choosing between two codegen designs with
standalone-lane implications.
