---
id: 7122
title: "IR: infer empty-literal string[] from pushes; push / join / indexOf / includes on it (select:array-method-unsupported)"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
completed: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7108]
assignee: "ttraenkler/lead-c-remote"
---

# IR: infer an empty-literal `string[]` from its pushes

## Problem

`array-method-unsupported` census on main (`b64438ca`), standalone lane, original
harness assembly, `trackIrOutcomes`, `JS2WASM_IR_SHAPE_DIAG=1`:

| sample | rows | `isFloatTypedArrayConstructor` | `printStringCodePoints` | test bodies |
| --- | ---: | ---: | ---: | ---: |
| N=200 SEED=7 | 18 | 12 | 6 | 0 |
| N=400 SEED=11 | 32 | 27 | 5 | 0 |

Both clusters are harness helpers (they are #7108's two follow-ups); no test
body (`<module-init>`) reports this code first.

- `isFloatTypedArrayConstructor` (`floatArrayConstructors.indexOf(arg)`) is
  not an array-method gap: the selector's family arm merely runs first. The
  receiver is a module-level `var` holding host constructors, and reading any
  module `var` from a function is `expr-ident-not-in-scope` today
  (`var a = [1, 2]; function f() { return a.length; }` refuses the same way).
  Left alone here.
- `printStringCodePoints` (`const buf = []; … buf.push(formatted); return
  buf.join(' ')`) needed three things the IR lacked: string element evidence in
  the empty-array inference, `push` into a `vec<string>`, and `join` admission
  for a vec that is not a dense literal.

## Change

- `src/ir/array-element-inference.ts`: a may-alias group whose ONLY concrete
  evidence is `string` resolves as `elementKind: "string"` (never i32-narrowed).
  Escapes, mixed evidence, external joins and spread pushes still reject.
- `src/ir/array-element-lowering.ts`: `inferredEmptyArrayVecHint` allocates such a
  literal as a vec of the backend string carrier (the representation a dense
  string literal already gets); a backend without one demotes. `push` into a
  `vec<string>` stores the value only when it lowers as a `string` (no
  coercion), growing through the per-vec-type `__vec_elem_set_<idx>` helper.
- `src/ir/from-ast.ts`: the declaration arm delegates both inferred families to that helper; the empty-literal
  allocation resolves a `string` element to the carrier.
- `src/ir/array-methods/selection.ts`: the element-family classifier answers
  `string` for an identifier bound to `[]` whose group the SAME inference (same
  oracle as from-ast — `ctx.oracle` is now passed in) closes as `string[]`, so
  the selector and the lowering cannot disagree. The #7108 lowering of
  `join` / `indexOf` / `includes` is unchanged.

Element reads (`buf[i]`) of such a vec are not in this slice: an in-range read
demotes on the existing "native string vec read is not proven in bounds" arm,
an out-of-range one adds `undefined` evidence and the group rejects as mixed.

## Measured

- Census N=200 SEED=7: `array-method-unsupported` 18 → 12. The 6
  `printStringCodePoints` rows now stop at `param-type-not-resolvable`
  (`for (let symbol of string)` over the untyped parameter); no other row
  changed. `ir_only_pass` in the sample: 0 → 0 (as #7108 predicted, this is a
  code shift for that unit, not an IR-emitted unit).
- Conformance A/B (`runTest262File`, standalone, QuickJS provider rebuilt per
  state): 39 files (all 11 `printStringCodePoints` tests from both samples + 28
  others) — base 30 pass / 6 fail / 3 CE, after identical, 0 flips.
- `tests/issue-7122-ir-inferred-string-vec.test.ts`: IR compile, legacy-only
  compile (`experimentalIR: false`) and node agree on standalone and gc;
  refusals for mixed / escaping / unproven pushes.

## Left

1. `printStringCodePoints`: `for-of` over an untyped string parameter
   (`param-type-not-resolvable`).
2. `isFloatTypedArrayConstructor`: module-level `var` reads from functions,
   then an identity search over host-constructor (externref) elements.
3. Bounds-proven element reads of a native string vec.
