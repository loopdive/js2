---
id: 6982
title: "Native regime in a JS environment: Symbol.toPrimitive, indexOf(undefined), await-settled yield, import.meta.url"
status: in-progress
sprint: current
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
goal: architecture
parent: 5385
related: [6708, 6979]
assignee: ttraenkler/opus-6982-values
loc-budget-allow:
  # 2026-10-14 (#6982): one import + one guarded call each; logic lives in new sub-modules
  - src/codegen/property-access-dispatch.ts
  - src/runtime.ts
import-cycles-allow:
  - largestSccSize: 706 # 2026-10-14 (#6982): the two new codegen helpers (classes/class-symbol-to-primitive-operand.ts, expressions/import-meta-url-native.ts) call compileExpression/coerceType and are called from binary-ops/property-access-dispatch, so they sit in the codegen SCC like every sibling helper
---

# Native regime in a JS environment: four value-semantics defects

Slice A of #6708 flips the default `semanticProviders` to `native-first`. In a
JavaScript environment (exports read through `wrapCompiledExports`), the
equivalence gate goes red on these 8 rows, all reproducible on main with an
explicit `{ semanticProviders: "native-first" }`:

| File | Row | Symptom |
| --- | --- | --- |
| symbol-toPrimitive | arithmetic | `a + b` on `[Symbol.toPrimitive]` instances → NaN |
| symbol-toPrimitive | comparison operators | `a > b` → false |
| array-indexof-no-arg | finds an element that IS undefined | `indexOf(undefined)` → -1 |
| array-indexof-no-arg | finds the LAST element that is undefined | `lastIndexOf(undefined)` → -1 |
| await-settled-operand-yields | `await null` in an async arrow returns to the caller first | runs synchronously |
| await-settled-operand-yields | sibling async functions interleave like JS | no interleave |
| import-meta | import.meta.url reflects the loader-injected value | not a string |
| import-meta | import.meta.url stored in a variable | null |

## Acceptance criteria

- All 8 rows pass under `native-first` in a JS environment.
- Standalone output unchanged or improved.
- `tests/issue-6982-regime-value-semantics.test.ts` covers each construct under
  both `native-first` (JS environment) and `target: "standalone"`.

## Root causes

1. **Symbol.toPrimitive** — the regime's object `+` (`emitObjectAdd`) and
   relational (`emitAnyRelational`) cascades compile each operand straight to
   externref, then reduce it with the runtime `__to_primitive`. A class instance
   is a nominal struct whose `[Symbol.toPrimitive]` METHOD
   (`${Class}_@@toPrimitive`) has no runtime dispatch in the native regime
   (`__call_@@toPrimitive` is host-only, `__class_to_primitive` walks
   valueOf/toString only). The struct came back unchanged, so `a + b` was NaN
   and `a > b` false. Unary `+` worked because `coerceType(struct → f64)` calls
   the method while the typeIdx is still known.
2. **indexOf()/lastIndexOf()** — `emitIndexOfAbsentSearchValue` (#5121) treated
   every ref element type as "can never be undefined" and answered -1. Under
   native strings `(string | undefined)[]` is a native-string vec whose
   `undefined` is the null carrier, which is exactly what the explicit
   `indexOf(undefined)` compiles to.
3. **await of a settled operand** — the native drive lane (`asyncFnNeedsDrive`)
   elides a body whose every await is settled and runs it inline; the driven
   frames themselves take a synchronous fast path for a fulfilled/non-Promise
   operand; and native-drive closures are parked, so an async arrow always ran
   inline. #6780 fixed the host lane only.
4. **import.meta.url** — `__get_import_meta_url` returns a JS string externref;
   under native strings the `string`-typed read coerced it with a bare
   `ref.test $AnyString`, which fails on a JS string, so it read as null.

## Implementation

- `src/codegen/classes/class-symbol-to-primitive-operand.ts` (new): when an
  operand is statically a class instance with `${Class}_@@toPrimitive`, compile
  it raw and reduce it at its ToPrimitive point with
  `coerceType(struct → externref, hint)` — the same engine unary `+`,
  `String()` and template literals use. Hint `default` for `+`, `number` for
  relationals; a string result stays a string. Left-to-right order of both
  evaluation and conversion is preserved. Every other operand keeps its
  lowering byte for byte (the predicate emits nothing when it declines).
- `array-includes-search-value.ts`: a native-string element vec searches the
  null carrier, so the absent argument matches the explicit spelling.
- Await, JS environment only (`!hostFreeEnvironment(ctx)`): the drive lane no
  longer elides settled-only bodies, driven frames use `alwaysAsyncAwait`, and a
  closure whose every await is statically settled takes the drive lane.
  `src/runtime/native-microtask-checkpoint.ts` (new) makes the JS value adapter
  queue one host microtask after each export call when the native ring has
  pending jobs, so fire-and-forget continuations run where JS runs them.
  Host-free targets (standalone/WASI) keep the synchronous fast path: making it
  regime-wide broke 30 standalone/WASI tests (#2865, #2895, #2906, #3228,
  #3723, #6428) whose drain contract relies on it.
- `src/codegen/expressions/import-meta-url-native.ts` (new): with native
  strings and a usable JS string bridge, marshal the value through
  `__str_from_extern`; `null`/JS `undefined` (no loader) stays the canonical
  `undefined`. Host-free targets keep the old lowering.
- `tests/equivalence/import-meta.test.ts` read raw `instance.exports`; under
  native-first it now reads through `wrapCompiledExports`, like
  `tests/equivalence/helpers.ts` on slice A.

## Known limits (not in scope)

- Symbol.toPrimitive: the operand must resolve to a struct name
  (`resolveStructNameForExpr`): `new N(1) < new N(2)` with inline `new`
  operands still takes the runtime path (also wrong on the host lane today).
- indexOf(): a native-string vec does not tell `undefined` from `null` or from a
  hole, so `["x", null].indexOf()` and a sparse `string[]` answer the null
  slot's index. The explicit `indexOf(undefined)` already did this (#5121 S2).
- Await: an async closure with a REAL suspension keeps its pre-existing native
  lowering (the native-closure park); standalone/WASI keep the synchronous
  fast path.
