---
id: 7292
title: "IR module-init: script-var array-literal storage (`var values = [2, 1, 3]`)"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7252, 7128, 2949, 7274]
assignee: "ttraenkler/c-lane-opus"
---

# #7292 — IR module-init: script-var array-literal storage

## Problem

A script `var` holding an array literal (`var values = [2, 1, 3]`,
`var arr = []`, `var invalidStrings = ["…", …]`) is refused in module-init as
`vardecl-module-storage-unrepresentable`: the IR has no module-binding value
kind for legacy's array slot.

## Outcome (2026-11-07): measured, zero-legacy yield 0, no code yet

This admission alone moves **no** test262 file to zero legacy units. Per the
dispatch rule, this issue stops at measurement with a docs-only PR. The design
below is ready for when the co-blockers listed here fall.

**Ownership check.** #7128's S5 ("array-literal targets") is about arrays as
`Object.defineProperty` targets on the open-object carrier. #2949 is the
dynamic value representation. Neither covers a script `var`'s array slot.
#7274 has no issue file on main.

## Measurement (main `c03f7d0e`, 2026-11-07)

Census command:
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 npx tsx scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone --jobs 3 --files-json …`
(ir 1213 / both 8742 / legacy 4493 units; zero-legacy 32 files.)

### What legacy allocates

Probe: a script with `var values = [2, 1, 3]; var strs = ["a", "b"]; var
empty = []; var objs = [{}]`, compiled `--target standalone`:

| Initializer | `__mod_` slot |
| --- | --- |
| numeric literals | `(mut (ref null $__vec_f64))`, struct `{length i32, data (ref null $__arr_f64)}` |
| string literals | `(mut (ref null $__vec_ref_N))`, a vec of `$AnyString` refs |
| `[]`, `[{}]` | `(mut (ref null $__vec_externref))` |

The IR builds vec values through the same `getOrRegisterVecType` registry
(`src/ir/integration.ts`), so an f64 / string vec binding would share legacy's
struct by construction. `scriptVarHome` (`src/codegen/index.ts`) names no home
for any vec slot today. That is the one reason these bindings resolve as
`vardecl-module-storage-unrepresentable`.

### Population

There are **369** array-literal storage parts in **191** files, across module-init and
harness units. By element kind:

| Initializer | Parts |
| --- | ---: |
| `[]` (empty) | 80 |
| constructor lists `[Float64Array, …]` / `[Int32Array, …]` / `[Uint8Array, …]` (testTypedArray) | 108 |
| function lists `[makePassthrough, …]` (testTypedArray) | 51 |
| string literals | 46 |
| numeric literals | 41 |
| nested arrays | 25 |
| other (`[undefined, null, …]`, `Promise.reject(…)`, Temporal objects, arrows) | 18 |

### Sole-blocker files

Of the files whose only legacy unit is `<module-init>`, **76** carry an
array-literal storage part. Only **1** has no other statement-level refusal,
and **14** have exactly one more:

| Other refusals | Files | Next blocker |
| ---: | ---: | --- |
| 0 | 1 | `built-ins/Array/15.4.5.1-5-1.js`: `var a = []; a[4294967295] = …`. Index 2^32−1 is **not** an array index, so it is an ordinary property on the array object, which the IR vec has no slot for. |
| 1 | 4 | `for-init-var-kind` (`for (var i = 0; …)`): `exponentiation/applying-the-exp-operator_A18.js`, three intl402 Temporal `inLeapYear` files (Temporal calls are masked inside the loop) |
| 1 | 3 | `expr-array-method-not-lowerable`: `invalidStrings.forEach(callback)` (Temporal ×3) |
| 1 | 2 | nested-array `tests` read (`expr-module-storage-unrepresentable`) |
| 1 | 5 | `a.flat(Infinity)`, `Object` not in scope ×1, `Object.defineProperty(arr, …)` (#7128 S5), destructuring assignment from `vals`, `Intl` options |

Co-occurring refusal arms in the same module-inits, by parts:

| Arm | Parts | Note |
| --- | ---: | --- |
| `expr-ident-not-in-scope` | 511 | #7278 / #7267 |
| `vardecl-module-value-flow` | 466 | |
| `expr-array-method-not-lowerable` | 59 | |
| `expr-module-storage-unrepresentable` | 59 | reads of these same vars; they clear with the storage |
| `closure-return-type` | 52 | |
| `expr-object-define-property-target` | 23 | |
| `for-init-var-kind` | 11 | |

**Expected zero-legacy delta of the bounded admission: 0.**

## Implementation Plan (for when a co-blocker falls)

- **Module.** `src/ir/module-binding-value-kinds.ts` gets a
  `{ kind: "vec", element: "f64" | "string" }` value kind beside
  `class-instance` (#7252's precedent: one script `var`, sole home, every write
  certified).
- **Home.** `scriptVarHome` (`src/codegen/index.ts`) adds a `"vec"` home when
  the slot is `(ref null $__vec_f64)` or the native-string vec. The
  `externref` vec of `[]` / `[{}]` stays homeless until the empty literal's
  element kind is provable from every later write.
- **Certification, shared by selector and from-ast** (the #7252 every-write
  pattern):
  - every write to the var is an array literal whose elements are all f64
    literals (or all string literals), with no holes and no spread;
  - every use is one the IR vec already lowers: index read in bounds,
    `.length`, an index write, `push`;
  - holes `[,1]`, mixed kinds `[1, "a"]`, `length` writes, `delete a[i]`,
    non-index keys (`a[4294967295]`), aliasing through a second var, closure
    captures and reassignment to a non-array all refuse with named arms.
- **Storage.** `resolveModuleBindingGlobal` (`src/ir/integration.ts`) maps
  the kind to the vec's IR type and checks it against legacy's global, the way
  `class-instance` does.
- **Quality criterion.** One value kind and one certification, both reused
  from #7252's arm shape; no new import; gc byte-identical where unclaimed.

## When to pick this up

Once `for-init-var-kind` (`for (var i = …)` in module-init) or array-method
callbacks (`forEach(fn)`) are admitted, re-run the census above. The pair
rows (4 + 3 files) become this admission's yield.
