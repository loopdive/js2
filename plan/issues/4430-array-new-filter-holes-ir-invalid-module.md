---
id: 4430
title: "Bounded sparse `new Array(n)` + filter holes: standalone IR route emits a non-validating module (in-tree #4222 test failing)"
status: done
completed: 2026-08-15
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
es_edition: 5
language_feature: array-holes
goal: standalone-gap
related: [4222, 4426]
origin: "2026-08-15 ES5-standalone session — tests/es5-array-new-filter-holes.test.ts case 'claims the bounded sparse route in standalone IR' fails WebAssembly.validate, reproduced identically at merge-base 63785cb."
---

# #4430 — bounded sparse route (standalone IR) emits a non-validating module

## Problem

The COMMITTED test `tests/es5-array-new-filter-holes.test.ts` case
"**claims the bounded sparse route in standalone IR**" (`#4222 —
representation and IR ownership` describe block) fails on current main:
`compile()` reports success but `WebAssembly.validate(result.binary)` is
false. A compile that hands back an invalid binary is strictly worse than a
compile error — the runner records it as CE with an opaque V8 message, and
in production it is a crash at instantiate.

Reproduced identically at merge-base `63785cb` (pre-existing; found during
the #4426 session's regression sweep).

## Implementation Plan

1. Reproduce: `npm test -- tests/es5-array-new-filter-holes.test.ts` — read
   the failing case's compile options in the test (it pins the IR/standalone
   route). Then get the REAL validation error: instantiate via
   `new WebAssembly.Module(result.binary)` in a probe and capture the V8
   message naming the function and instruction (`emitWat: true` on the same
   compile to read the body).
2. Suspect surface: the #4222 bounded-sparse lowering for `new Array(n)`
   holes on the IR path — `src/ir/` lowering for the array-holes route plus
   `src/codegen/expressions/new-indexed.ts` `holeyCarrier` branch
   (`getOrRegisterHoleyArrayType` / `ensureHoleyArrayNew`). Note the #4426
   session added a one-element branch ABOVE the `args.length === 1` length
   lowering in `new-indexed.ts` — confirm the failure predates it (it does —
   merge-base repro) but keep the branch in mind when reading the WAT.
3. Typical failure classes for this shape (check in order): a `struct.new`
   arg type vs holey-vec field mismatch; a `local.set` whose local was typed
   from the non-holey vec while the value is the holey type (sibling-cast
   hazard — same family as the #4426 length-set fix); an IR-emitted block
   type that disagrees with the legacy helper's result type.
4. Fix at the emission site; do not paper over with a stack-balance repair.
5. Verify: the whole `tests/es5-array-new-filter-holes.test.ts` file green;
   `tests/es5-standalone-array-filter.test.ts` green;
   `pnpm run check:ir-fallbacks` unchanged (no bucket growth); scoped
   standalone run over `built-ins/Array/prototype/filter` for collateral.

## Acceptance criteria

- All cases of `tests/es5-array-new-filter-holes.test.ts` pass (the module
  validates).
- No IR-fallback bucket growth; filter-adjacent suites stay green.

## Resolution (2026-08-15)

**Root cause — the branded carrier is invisible to the IR type system, so the
CALL to the element-store helper was unrepresentable.**

V8's real message (probe `.tmp/p4430.mts`, `new WebAssembly.Module(binary)`):

```
Compiling function #50:"test" failed:
  local.set[0] expected type (ref null 45), found local.tee of type (ref null 2)
```

with `45 = $__holey_array`, `2 = $__vec_externref`. Reading the WAT:

```wat
(block (result (ref null 45)) … struct.new 45)   ;; __ir_holey_array_new
local.tee 0                                      ;; $$ir3 : (ref null 2)  ← erased here
…
local.set 2                                      ;; __inl14_p0 : (ref null 45)
```

`local.tee`'s result type is the LOCAL's type, not the value's, so the holey
brand is erased at the binding and the (inlined) call to
`__vec_elem_set_<holeyIdx>` receives the parent type. The inliner only changed
the wording — the un-inlined `call` was equally invalid.

The binding is typed from the IR's logical `vec<externref>` `IrType`, which
carries **no brand**: `from-ast.ts` gives `__ir_holey_array_new` the result type
`irVec(irVal({kind:"externref"}), true)`. Legacy does not have this problem
because `inferArrayVecType` / `moduleGlobalWasmType` pin the slot to
`$__holey_array` from `ctx.holeyArrayDeclarations`. Pinning the same carrier in
the IR is **not** reachable from here: `IrType.vec`'s `layout` is keyed by
ELEMENT type during Program-ABI preparation, and `attachIrVecLayouts` throws
`"IR vec type already carries a different prepared layout"` if a site
pre-attaches a different carrier for the same element.

**Fix (`src/codegen/vec-elem-set.ts`) — take the PARENT carrier in the helper.**
`$__holey_array` is a `final` subtype of `$__vec_externref`, and BOTH fields
this helper touches (`length`, `data`) are declared on that parent. So the
signature and every `struct.get`/`struct.set` now use `vecDef.superTypeIdx` for
the holey carrier. A holey instance is a valid argument by subtyping, so the
legacy path (which does type its binding `$__holey_array`) is unaffected, and no
cast is introduced in either direction. The hole-preserving growth semantics —
`$Hole`-filled `array.new`, the `[oldLength, idx)` `array.fill` — are untouched
and still keyed on `isHoleyArrayType`. Same idiom as the #4426 `.length=`
receiver fix: type the receiver at the level that owns the fields being written.

**Residual (deliberate, filed here, not fixed):** the IR still has no way to
express "this logical `vec<externref>` is the branded sparse carrier". Nothing
today needs it — the IR dispatches holes from the AST
(`isHoleyArrayConstructor` / `isHoleyArrayFilterCall` /
`isHoleyArrayElementStore`), and the filter helper takes `externref` — but a
future holey-only WasmGC operation that needs the concrete type at a call
boundary would hit the same wall. Closing it means keying vec layouts on more
than the element type.

## Test Results (2026-08-15)

| Check | Before | After |
| --- | --- | --- |
| `tests/es5-array-new-filter-holes.test.ts` | 8 pass / 1 fail (`claims the bounded sparse route in standalone IR`: `WebAssembly.validate` false) | 9 pass |
| `tests/es5-standalone-array-filter.test.ts` | 7 pass | 7 pass |
| `pnpm run check:ir-fallbacks` | OK | OK — no unintended / post-claim / module-level increases |
| probe `.tmp/p4430.mts` | `validate false` + the `local.set` message above | `validate true` |
