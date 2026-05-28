---
id: 1596
title: "Function.prototype.apply / .call not accessible on compiled Wasm functions (~46 fails)"
status: in-progress
created: 2026-05-24
updated: 2026-05-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: functions, Function.prototype, spread, apply, call
goal: spec-completeness
sprint: 56
test262_fail: 46
test262_category: language/expressions/array, built-ins/Function/prototype/call, built-ins/RegExp
---
# #1596 — `Function.prototype.apply` / `.call` not accessible on compiled functions

## Problem

**~46 test262 failures** with error `apply is not a function` or `call is not a function` when test code calls `.apply(...)` or `.call(...)` on a compiled Wasm function directly.

### Observed errors (2026-05-24)

```
test/language/expressions/array/spread-sngl-literal.js
  L41:3 apply is not a function

test/language/expressions/array/spread-mult-literal.js
  L41:3 apply is not a function

test/language/expressions/array/spread-obj-getter-descriptor.js
  L54:3 apply is not a function

test/built-ins/Function/prototype/call/S15.3.4.4_A3_T8.js
  call is not a function

test/built-ins/RegExp/prototype/Symbol.replace/poisoned-stdlib.js
  original.apply is not a function
```

### Pattern

The test pattern in `spread-sngl-literal.js`:
```js
(function() {
  assert.sameValue(arguments.length, 3);
  callCount += 1;
}.apply(null, [...[3, 4, 5]]));   // <-- .apply on compiled IIFE
```

Compiled Wasm functions are WasmGC function references (via `$js_function` struct or similar). When JS code accesses `.apply` or `.call` on them, the engine cannot find these methods because WasmGC funcrefs don't automatically inherit `Function.prototype`.

### Failure count breakdown

| Method | Count |
|--------|-------|
| `apply` | ~29 |
| `call` | ~16 |
| `original.apply` | ~1 |

## Root cause hypothesis

Compiled functions are represented as WasmGC structs (not native JS `Function` objects), so `.apply` / `.call` property lookups on them return `undefined`. The fix requires either:

1. **Proxy wrapper**: wrap every compiled function in a JS `Function` shell that delegates to the Wasm export, so `Function.prototype` methods are inherited
2. **Host method export**: intercept property access on function-struct refs and route `.apply` / `.call` to a host-side implementation
3. **Static rewrite**: detect `fn.apply(thisArg, argsArray)` call patterns at compile time and lower them to a direct call with spread

Option 3 is compile-time (zero runtime overhead) but only covers the static-dispatch case. Options 1–2 handle dynamic `fn.apply` but add overhead.

## Acceptance criteria

- `(function() {}).apply(null, args)` works — arguments bound correctly
- `(function() {}).call(thisArg, a, b)` works
- `Function.prototype.apply.call(fn, thisArg, argsArray)` works
- All ~46 test262 files pass
- No regressions in existing function / call / spread tests

## Notes

- This may also affect `Function.prototype.bind` (not counted separately in current harvest; check `bind is not a function` occurrences)
- Overlaps conceptually with WasmGC object leakage (#983) — compiled objects escape to JS and don't have expected prototype methods
- If a static-rewrite approach is used for `fn.apply(...)`, must handle the case where `fn` is not a literal (dynamic dispatch)
- The `spread-*.js` failures suggest the array spread `[...arr]` lowering itself calls `.apply` internally — inspect the spread codegen path before assuming the test calls `.apply` directly

## Implementation Plan (arch spec, 2026-05-27)

### What already works (do NOT touch)

`compileCallExpression` in `src/codegen/expressions/calls.ts` already has a
mature static-rewrite for `.call`/`.apply`, in the `propAccess.name.text ===
"call" || "apply"` block (currently ~line 2091). It covers three resolvable
receiver shapes and passes its 6 unit tests in `tests/issue-1596.test.ts`:

- **Case 0 (~2101)** — receiver is a *function literal* `(function(){})` /
  `(()=>{})`. Rewrites to a direct `fn(args)` synthetic call (reuses the
  IIFE-inlining path, binds `arguments`). For `.apply` it requires the args to
  be a **statically-flattenable array literal** via `flattenStaticArrayElements`
  (~1259) — handles `[a,b]` and `[...[3,4,5]]` (nested *array-literal* spread).
- **Case 1 (~2150)** — receiver is a bare **identifier** resolvable to a
  `closureInfo` (`ctx.closureMap`) or a `funcIdx` (`ctx.funcMap`). Full
  `.call` and `.apply` (array-literal args) with rest/optional/default param
  handling.

Verified working on main (probe, 2026-05-27): `g.apply(null,[1,2,3])`,
`g.call(null,6,7)`, `(function(){}).apply(null,[3,4,5])`,
`(()=>{}).apply(null,[10,3])` — all correct. **The 6 passing unit tests are the
no-regression guard.**

### Root cause of the residual fails

Both rewrites are **purely syntactic and static**. They bail to the generic
path the moment either operand is dynamic, and the generic path lowers
`recv.apply` as a host property lookup on a value that — for a compiled function
— is a bare WasmGC funcref/closure-struct with no `Function.prototype`. The host
then throws `apply is not a function` / `call is not a function`.

Confirmed failing buckets (probe with `buildImports`, 2026-05-27):

| # | Pattern | Why it bails today |
|---|---------|--------------------|
| B | `(function(){}).apply(null, dynArr)` — args not a literal (`[1,2].concat(x)`, an identifier, a call result) | Case 0 `flattenStaticArrayElements` returns `undefined` → falls through |
| C | `(function(){}).apply(null, [{...o}])` — args literal contains an **object** spread / non-flatten element | `flattenStaticArrayElements` rejects (spread of non-array) → falls through |
| F | `Function.prototype.apply.call(fn, thisArg, argsArr)` / `Function.prototype.call.call(...)` | receiver is `Function.prototype.apply`, not a fn literal/identifier — no case matches |
| H | `cb.call(...)` / `cb.apply(...)` where `cb` is a **function-typed value** (parameter, property, array element, call result), not a bare identifier | `ts.isIdentifier(innerExpr)` is false → no case matches; the dynamic closure value reaches the host |

These are the ~7/10 residual fails. The `spread-*.js` test262 files are
**Case C** (the args literal holds an object-spread element) and **Case B**
(dynamic source), NOT the spread lowering itself — the array-spread codegen does
not call `.apply` internally; the test source literally writes `fn.apply(null,
[...])`.

### Fix — extend the existing block, three additive sub-fixes

The machinery to invoke a dynamic function *value* already exists: the
`call_ref`-based closure-value dispatch (see `compileOptionalDirectCall`
~line 712-768, and the param/local closure-value dispatch at ~7115-7403). The
fix routes the dynamic `.call`/`.apply` receivers into that path instead of
letting them fall through to the host. Order the sub-fixes so each is
independently testable.

**Sub-fix 1 — Case C/B: function-literal `.apply` with non-flattenable args
(highest value, smallest change).**
In Case 0, when the receiver IS a function literal but `flattenStaticArrayElements`
returns `undefined` (dynamic source or object-spread element), do NOT fall
through. Instead:
- Lower the receiver function literal as a **closure value** (it already has a
  `closureInfo` — `compileArrowOrFunctionExpressionAsClosure`, ~1194), store in
  a local.
- Evaluate the thisArg for side effects, drop it (standalone fns ignore `this`).
- Evaluate the args-array expression to a WasmGC array/vec value.
- Emit a **spread-into-positional** adapter: read the vec length, `array.get`
  each element coerced to the callee's param type, then `call_ref` the closure's
  funcref. For the variadic/unknown-arity case, reuse the **rest-param packing**
  already written at ~2188-2212 (pack the vec into the callee's rest vec).
  Since a function *literal* has a known param signature here, the fixed-arity
  branch (read `argsVec[i]` for `i in 0..paramCount`, pad missing with
  `pushDefaultValue`) is sufficient and avoids needing `arguments`-from-vec.
- *Edge:* if the literal reads `arguments.length`/`arguments[i]` (Case C
  spread-*.js asserts `arguments.length === 3`), the fixed-arity adapter must
  also build the `arguments` object from the runtime vec. Simplest: when the
  callee body uses `arguments` (already tracked — `bodyUsesArguments`, grep
  `usesArguments`), thread the runtime args vec into the existing
  arguments-object construction instead of the static literal list.

**Sub-fix 2 — Case H: `.call`/`.apply` on a non-identifier function value.**
Generalise the `ts.isIdentifier(innerExpr)` gate. When `innerExpr` is not an
identifier/literal but its TS type **has call signatures**
(`getCallSignatures().length > 0`) and it lowers to a closure-struct ref:
- Compile `innerExpr` to its closure-struct value, `local.tee`.
- Resolve the funcType: the closure struct's field 0 is the funcref; recover the
  `funcTypeIdx` from the matching `closureInfo` (look up by the struct typeIdx in
  `ctx.closureMap`/the closure-type registry, same resolution
  `compileOptionalDirectCall` does at ~744).
- For `.call`: push self + positional args (slice(1)), `call_ref`.
- For `.apply`: push self + spread-from-vec args (reuse Sub-fix 1's adapter),
  `call_ref`.
- thisArg (args[0]) evaluated-and-dropped for standalone closures.
- If the type has no call signatures (genuinely a non-function), fall through so
  the existing `assert.throws(TypeError, ...)` behaviour is preserved (mirrors
  the `.bind` guard at ~2068).

**Sub-fix 3 — Case F: `Function.prototype.apply` / `Function.prototype.call`
explicit form.** Add a match at the top of the `.call`/`.apply` block: detect
`propAccess.expression` === `Function.prototype.apply` (a PropertyAccess chain
`Function`→`prototype`→`apply`/`call`) used as the receiver of an outer
`.call(fn, thisArg, args)`. Rewrite `Function.prototype.apply.call(fn, t, arr)`
→ treat `fn` as the receiver, `t` as thisArg, `arr` as the apply args, then
delegate to Sub-fix 1/2. Likewise `Function.prototype.call.call(fn, t, ...a)` →
`fn.call(t, ...a)`. This is a pure AST reshape feeding the same handlers.

### Files to modify

- `src/codegen/expressions/calls.ts` — the `.call`/`.apply` block (~2091-2360).
  All three sub-fixes live here. The spread-from-vec adapter is the one new
  helper (~30-40 LOC); everything else reshapes AST or reuses existing
  closure/rest emit code. No `src/runtime.ts` change needed — pure-Wasm
  `call_ref`, standalone-safe (no new host import), satisfies CLAUDE.md
  dual-mode.
- `tests/issue-1596.test.ts` — add cases for B/C/F/H (see below). Keep all 6
  existing tests green (regression guard).

### Wasm lowering sketch (the spread-from-vec adapter)

```wasm
;; given: closure-struct ref in $cls, args vec ref in $argv, known paramCount=N
local.get $cls                     ;; self (closure as first call_ref operand)
;; arg 0..N-1: read from the runtime vec, coerce to param type, pad if short
local.get $argv; struct.get $Vec 0 ;; len  (i32)
;; for i in 0..N:  (i < len) ? coerce(argv.arr[i]) : default
;;   local.get $argv; struct.get $Vec 1 (arr); i32.const i; array.get $Arr; <coerce>
;;   else pushDefaultValue(paramType[i])
local.get $cls; struct.get $Cls 0  ;; funcref (field 0)
call_ref $funcType                 ;; -> return value (already correct Wasm type)
```

For variadic/rest callees, pack the vec directly into the callee's rest vec
(the code at ~2188-2212 already does exactly this for the identifier path —
factor it into a shared helper so both Case-1 and the new dynamic path call it).

### Acceptance criteria (refines the issue's list)

1. All 6 existing `tests/issue-1596.test.ts` cases stay green.
2. New cases pass: B `(function(){}).apply(null,[1,2,3].concat([4]))` →
   `arguments.length===4`; C `(function(){}).apply(null,[{...o,c:4}])` →
   1 arg; F `Function.prototype.apply.call(g,null,[1,2])` → `2`; H
   `cb.call(null,5)` for a function-typed parameter `cb`.
3. The named test262 files pass: `language/expressions/array/spread-sngl-literal.js`,
   `spread-mult-literal.js`, `spread-obj-getter-descriptor.js`,
   `built-ins/Function/prototype/call/S15.3.4.4_A3_T8.js`.
4. No regression in `tests/arrow-call-apply.test.ts`, `tests/equivalence/arrow-call-apply.test.ts`,
   or the function/closure equivalence buckets.

### Sequencing note for the implementer

Do Sub-fix 1 first (function-literal `.apply` dynamic args) — it alone clears
the `spread-*.js` bucket and is the lowest-risk (receiver type is already known,
only the args side becomes runtime). Then Sub-fix 2 (dynamic receiver value),
then Sub-fix 3 (explicit `Function.prototype.*` reshape, which is a thin
adapter over 1+2). Each sub-fix is independently shippable with its own test
case, so the PR can land incrementally if any one proves hard.
