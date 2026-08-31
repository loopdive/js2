---
id: 5223
title: "Compiled-class instance toString / Symbol.toStringTag dispatch not wired — new Temporal.PlainDate(…).toString() returns \"[object Object]\""
status: done
completed: 2026-08-30
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
# 2026-08-30 (#5223): the read-side registration must live where the dot and
# bracket READS are compiled, and the demand set must be declared on the
# codegen context. Both are god-files by the gate's reckoning; the alternative
# (a new module for a 6-line predicate plus one Set field) would add a file
# without moving the coupling anywhere. property-access.ts: the exported
# `recordDynamicClassAccessorRead` helper + its root-cause comment + two call
# sites. context/types.ts: one `Set<string>` field + the comment that says why
# it is separate from `hostDynamicClassMethodNames`.
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/context/types.ts
# 2026-08-30 (#5223): compileElementAccessBody +9 is the bracket twin of the
# dot read's one-line registration (a literal-string-key guard + the call, with
# the comment that says why it sits on the externref arm and not at the entry
# point — the entry point would have to re-ask the checker for the receiver's
# Wasm kind, which the oracle ratchet correctly refuses). createCodegenContext
# +1 is the single new Set field's initializer. Neither is a new
# responsibility — splitting either for one statement would cost more than it
# saves.
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #5223 — compiled-class instance `toString` dispatch

## Problem

`new Temporal.PlainDate(2020,3,4).toString()` returns `"[object Object]"`
instead of `"2020-03-04"` — the compiled class's prototype `toString` (and
`Symbol.toStringTag`) is not consulted when the instance crosses to the
host / is stringified. Found by dev-temporal-wire validating PR #5318.

## Direction

Related family: #5201/#5202 dispatch exports and the #5318 `.prototype`
dynamic-lane fix. Measure whether the miss is (a) host-side `toString`
resolution on the wrapped instance, or (b) string-coercion paths bypassing
the class dispatch surface. Reduce with a plain user class first
(`class P { toString(){ return "x"; } }` via a dynamic receiver) — if that
also fails, this is general, not Temporal-specific; say so in the PR.

## Acceptance criteria

1. Reduced repro (plain class + Temporal shape) returns the prototype's
   toString result, host lane; new tests failing on base.
2. `String(inst)`, template-literal interpolation, and `"" + inst` measured.
3. No regressions in class-dispatch scoped runs (#5201/#5202 files).
   Gates green.

## Notes

- Siblings #5221/#5222. Id reserved with a degraded PR scan; manually
  checked against open PR head branches 2026-08-30.

## Implementation notes (2026-08-30)

### What the two reported shapes turned out to be

The issue bundled two symptoms. Measured on the #5221 stack tip, they are
**three separate defects**, and only one of them is what the title says.

1. **The headline was ALREADY FIXED on this base.**
   `new Temporal.PlainDate(2020,3,4).toString()` answers `"2020-03-04"`, not
   `"[object Object]"`. The dev-temporal-wire report was against a base that
   predates #5221's lowering fixes. The `instanceToString` row is therefore
   promoted out of `knownGaps` into the asserted `SUPPORTED` set so a
   regression is loud instead of silently "still a known gap".

2. **The real, general defect this PR fixes: a dynamic property READ of a
   compiled class ACCESSOR answered `undefined`.** Reproduced on a plain user
   class in one module, so it is not Temporal-specific:

   ```ts
   class P { v = 3; get y() { return this.v + 1; } other() { return "o"; } }
   function f(a: any) { return a.y; }      // undefined on base
   function g(a: any) { return a.other(); }// "o" — worked on base
   ```

   ROOT CAUSE. The `__member_kind_<key>` / `__call_get_<key>` host surface
   (#3123) is emitted **only for keys some site put in
   `ctx.hostDynamicClassMethodNames`**, and every writer of that set is a CALL
   site, a WRITE site (`compilePropertyAssignmentExternSet`), or a class-VALUE
   crossing (`emitLazyClassObjectGet`). A bare READ registered nothing, so the
   module contained no getter bridge at all. #5204 had already spotted this
   hole and closed it **only for externref-backed classes** (`class D extends
   Array`), whose members are bridged unconditionally; an ordinary WasmGC-struct
   class stayed demand-driven and kept the gap.

   WHY THE OBVIOUS REPRO DOES NOT REPRODUCE. `const a: any = new P(3); a.y`
   works on base — the initializer is statically visible so the read lowers to
   a direct getter call. The defect needs a receiver the compiler cannot
   narrow: a parameter, or an `Object.create(P.prototype)` result.

3. **NOT FIXED, characterised instead: `Temporal.PlainDate.from(...)` results.**
   Re-measured after the fix above, byte-identical — this is a *different*
   defect. `.from()` hands back a host object whose prototype is the provider's
   compiled `PlainDate` prototype, and **every member read off that prototype
   answers `undefined` in the consumer**: `typeof
   Temporal.PlainDate.prototype.toString` is `"undefined"`, `d.year` is
   `undefined`, while `Object.getOwnPropertyNames(PlainDate.prototype)` lists
   all 31 names. The reason is cross-module: the host boundary resolves
   compiled class members against the **CALLING module's** exports. The
   provider binary exports 141 `__member_kind_*` and 41 `__call_get_*`
   (counted); the consumer exports none, so nothing resolves. A `new`-built
   instance escapes this because its host proxy carries the provider's export
   slot. Wants its own issue: *cross-module compiled-class member resolution*.

### Design choice worth keeping

The read demand goes into a **separate** set, `hostDynamicClassAccessorReads`,
not into `hostDynamicClassMethodNames`. The method set also relaxes the
arity/rest admission rules for `__class_call_*` bridges
(`!ctx.hostDynamicClassMethodNames.has(memberKey)` guards in
`emitClassMemberKindExports` and the bridge collector), and a bare property
read must not widen the method-bridge surface. The new set feeds only
`emitClassMemberKindExports`, the entry gate, and `classBridgeNeedsNumberBox`
(needed: a numeric getter's bridge must box its f64 result).

It is intersected against `ctx.classAccessorSet` at **finalize**, after every
class body is compiled — so a module that reads `.length` off an `any` and
declares no `length` accessor emits byte-identical output. Registration is
also skipped for standalone/WASI (a different mechanism, #4455) and for
statically-narrowed receivers (`resolveWasmType(objType).kind !== "externref"`).

### Also measured, also not fixed

- `Object.getOwnPropertyDescriptor(P.prototype, "y")` returns a descriptor with
  **no `get` slot** in the host lane. The reflective descriptor surface for
  class accessors is separate from the dispatch surface this PR wires;
  standalone gets it right via #4455. Pinned as a base reading in
  `tests/issue-5223-instance-tostring-dispatch.test.ts`.
- `Symbol.toStringTag` on a compiled class instance answers `undefined`, so
  `Object.prototype.toString.call(inst)` still reports `[object Object]`.
  General (reproduced on a plain user class in one module), not
  Temporal-specific. Recorded as the `instanceToStringTag` harness gap that
  replaces the promoted `instanceToString` row.
- `Object.getPrototypeOf(Object.create(P.prototype)) === P.prototype` is
  **false** in the host lane (identity is not preserved through the proto
  proxy), while it is true for `new P()`. Unrelated to accessor dispatch;
  noted so the next reader does not re-derive it.
