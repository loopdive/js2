---
id: 1550
title: "spec gap: dstr-binding default initializer evaluated when value is non-undefined (`init-skipped` pattern)"
status: done
created: 2026-05-20
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, default-parameters
goal: spec-completeness
sprint: 52
parent: 779
related: [1432, 1450, 1451, 1454]
note: "Verified 2026-05-21: corrected file path destructuring.ts → statements/destructuring.ts"
---
# #1550 — Destructuring default initializer must NOT be evaluated when value is non-undefined

## Problem

ECMA-262 §13.3.3.6 `IteratorBindingInitialization` / §13.3.3.7
`KeyedBindingInitialization` both gate the destructuring default-initializer
evaluation on **`v` being `undefined`**:

```
SingleNameBinding : BindingIdentifier Initializer_opt
  6. If Initializer is present and v is undefined, then
     a. Let defaultValue be the result of evaluating Initializer.
     b. Let v be ? GetValue(defaultValue).
     c. ...
```

`null`, `0`, `false`, `""`, `NaN` are **not** `undefined`, so the initializer
must be **skipped** for those values. test262 verifies this via a counter:

```js
var initCount = 0;
function counter() { initCount += 1; }

function f([w = counter(), x = counter(), y = counter(), z = counter()]
          = [null, 0, false, '']) {
  assert.sameValue(initCount, 0);   // <-- the assertion that fails
}
f();
```

We currently fail this assertion: `initCount` ends up at 4 (every counter ran)
because the destructuring lowering evaluates the initializer **unconditionally**
or guards on a wider "falsy / nullish" predicate instead of strict
`=== undefined`.

## Failure count

Across the May 2026 baseline (`benchmarks/results/test262-current.jsonl`,
`error_category == "assertion_fail"`), **252 tests** match `*-init-skipped.js`:

| Context | Fails |
| --- | --- |
| `language/statements/class/dstr/` (method param) | 72 |
| `language/expressions/class/dstr/` (method param) | 72 |
| `language/expressions/object/dstr/` (method param) | 10 |
| `language/statements/for-of/dstr/` | 9 |
| `language/expressions/async-generator/dstr/` (non-method) | 8 |
| `language/statements/for/dstr/` | 7 |
| `language/statements/function/dstr/` | 6 |
| `language/statements/async-generator/dstr/` | 6 |
| `language/statements/generators/dstr/` | 5 |
| `language/expressions/arrow-function/dstr/` | 4 |
| `language/expressions/function/dstr/` | 4 |
| `language/expressions/generators/dstr/` | 4 |
| `language/statements/let/dstr/` | 3 |
| `language/statements/const/dstr/` | 3 |
| `language/statements/variable/dstr/` | 3 |
| `language/expressions/assignment/dstr/` | ~5 |

#1451 acceptance criterion #3 references `init-skipped` for the class/object
method path, but the residual list above shows the bug is **wider than the
method path** — function-decl, arrow, generator, declaration-form,
assignment-form, and for-loop dstr all share the same defect, suggesting a
single shared lowering point. Fixing all paths consistently unlocks ~252 tests.

## Root cause (suspected)

Suspected root cause is in the shared destructuring helpers. Candidate sites
(verify which one(s) emit the initializer guard):

- `src/codegen/destructuring-params.ts` — `destructureParamArray`,
  `destructureParamObject`. Look for the `default` / `Initializer` arm and
  check whether the runtime guard is `__extern_is_undefined(v)` (strict
  undefined) or `!v` / `is_falsy(v)` (wider, wrong).
- `src/codegen/statements/destructuring.ts` (verified 2026-05-21 — file
  moved from `src/codegen/destructuring.ts` to `statements/`) — the
  statement-form declaration / for-loop variant.
- `src/codegen/expressions/assignment.ts` — destructuring assignment
  (`[a = init] = arr`); §13.15.5 has the same `undefined`-only guard.
- `src/runtime.ts` — helpers like `__extern_is_undefined`, `__is_undefined`.
  Confirm that the predicate used is **strictly `=== undefined`**, not
  `null || undefined`.

A likely sub-bug is the **eager** evaluation of the initializer: the lowering
may compute the default value *before* the value check and `select` between
them, instead of branching with `if`. With strict (eager-arg) evaluation the
`counter()` side-effect runs even when the value is non-undefined.

### Likely fix shape

For each binding element with an initializer:

```wasm
;; v already on the stack (or in local $v) as externref
local.get $v
call $__extern_is_undefined        ;; strict === undefined
if (result externref)
  ;; --- only evaluate Initializer in this arm ---
  <compile Initializer>
else
  local.get $v
end
local.set $bound
```

Make sure the initializer is **inside** the `if` block, not above it. Also
verify the `__extern_is_undefined` helper compares against `undefined`, not
`null` (some runtime helpers conflate the two).

## Acceptance criteria

1. `language/statements/function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js`
   passes (the canonical reference test in the issue).
2. `language/statements/function/dstr/dflt-obj-ptrn-id-init-skipped.js`
   passes.
3. `language/expressions/arrow-function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js`
   passes.
4. `language/statements/class/dstr/gen-meth-dflt-obj-ptrn-id-init-skipped.js`
   passes (proves the method path is also fixed).
5. `language/expressions/async-generator/dstr/dflt-obj-ptrn-id-init-skipped.js`
   passes.
6. `language/statements/{let,const,variable}/dstr/*-init-skipped.js` —
   declaration-form variant passes.
7. **No regressions**: the `dflt-*-init-throws.js` family must still throw
   when value IS undefined and initializer throws.
8. Total `assertion_fail` test262 count reduces by **≥ 200**.
9. Tests: `tests/issue-1550.test.ts` with one focused case per shape:
   function decl, arrow, generator, class method, assignment pattern,
   let/const/var declaration, for-loop init.

## Implementation plan

### Step 1 — locate the predicate

Grep for the runtime predicate used to choose between "value" and "initializer":

```bash
grep -nR "__extern_is_undefined\|__is_undefined\|destructureParam\|emitInitializer" src/codegen
```

For each match in the destructuring path, confirm:
- Is the predicate strict `=== undefined`? (good)
- Does the value `null` route to the initializer? (bug)
- Is the initializer pre-evaluated before the guard? (bug)

### Step 2 — fix lazy initializer evaluation

For each binding element with `Initializer`:

- Emit the bound value into a temp local `$tmp_v` (externref).
- Emit `__extern_is_undefined(local.get $tmp_v)` (or `ref.is_null` plus an
  externref undefined check via `__extern_eq(undefined, v)` — match the
  prevailing pattern in `__get_undefined()` callers).
- `if (result externref)` arm: compile the initializer expression here,
  inside the `then` branch. If the initializer is an `IsAnonymousFunction
  Definition`, also apply #1450 NamedEvaluation inside this branch.
- `else` arm: `local.get $tmp_v`.

### Step 3 — unify for class method path

The trampoline-padded `ref.null.extern` arg for missing method args
(documented in #1451 root cause §3) means the predicate must treat
`ref.null.extern` as `undefined`. Verify the trampoline either:
- Pads missing args with `__get_undefined()` (preferred), **or**
- The runtime predicate accepts both `null.extern` and the `undefined`
  externref (acceptable but slightly inconsistent).

### Step 4 — verify assignment-pattern parity

`src/codegen/expressions/assignment.ts` has its own destructuring path
for `({x = init} = obj)`. Apply the same guard. Cross-check
§13.15.5.5 — `DestructuringAssignmentEvaluation` for `AssignmentElement`
uses the identical `v === undefined` predicate (step 4).

### Step 5 — add `tests/issue-1550.test.ts`

```ts
import { runCases } from './harness';
runCases('issue-1550 dstr init-skipped', [
  ['fn-decl-ary',   `let n=0;function f([a=++n,b=++n,c=++n,d=++n]=[null,0,false,'']){return [a,b,c,d,n];};JSON.stringify(f())`,
                    '[null,0,false,"",0]'],
  ['fn-decl-obj',   `let n=0;function f({a=++n,b=++n}={a:null,b:0}){return [a,b,n];};JSON.stringify(f())`,
                    '[null,0,0]'],
  ['arrow',         `let n=0;const f=([a=++n]=[null])=>[a,n];JSON.stringify(f())`,'[null,0]'],
  ['gen-fn',        `let n=0;function* g([a=++n]=[null]){yield [a,n]};JSON.stringify(g().next().value)`,'[null,0]'],
  ['class-meth',    `let n=0;class C{m([a=++n]=[null]){return [a,n]}};JSON.stringify(new C().m())`,'[null,0]'],
  ['assignment',    `let n=0;let a;([a=++n]=[null]);JSON.stringify([a,n])`,'[null,0]'],
  ['var-decl',      `let n=0;var [a=++n]=[null];JSON.stringify([a,n])`,'[null,0]'],
  ['undef-fires',   `let n=0;var [a=++n]=[undefined];JSON.stringify([a,n])`,'[1,1]'],
]);
```

## Files to inspect

- `src/codegen/destructuring-params.ts` — primary culprit.
- `src/codegen/destructuring.ts` (if separate) — declaration form.
- `src/codegen/expressions/assignment.ts` — assignment pattern form.
- `src/codegen/class-bodies.ts` — method param + trampoline padding.
- `src/runtime.ts` — `__extern_is_undefined`, `__get_undefined`.

## Test Results (2026-05-27)

Three lowering points used `ref.is_null` to decide whether a destructuring
default fires, which wrongly fired for JS `null` (encoded as `ref.null extern`
in the WebAssembly JS API). Fixed to gate strictly on `undefined`:

1. `src/codegen/expressions/assignment.ts` — object assignment-pattern struct
   fast path (`{ a = 1 } = obj`): switched `ref.is_null` → `__extern_is_undefined`.
2. `src/codegen/expressions/assignment.ts` — array/tuple assignment-pattern
   externref-element path (`[a = 1] = arr`): switched `ref.is_null` →
   `__extern_is_undefined` for externref elements (plain wasm ref/ref_null
   elements keep `ref.is_null`, where a wasm-null slot legitimately means
   "missing").
3. `src/codegen/statements/destructuring.ts` `emitDefaultValueCheck` — added an
   `objectPropertySemantics` flag. The object-property binding paths
   (`destructureParamObject`, which also backs the statement-form `let {a=1}=…`
   via #1553b) now pass it; for `ref`/`ref_null` fields it converts to externref
   and uses `__extern_is_undefined` so JS `null` does not fire the default. The
   array/iterator binding callers (loops.ts) leave it false — a wasm-null
   element there can mean "iterator exhausted", which still fires.

Verified via `tests/equivalence/issue-1550-dstr-init-skipped.test.ts` (10 cases,
all green) using `assertEquivalent` (Wasm output compared against real JS
evaluation): array/object binding declarations, function array/object params,
array/object assignment patterns — all keep `null` (default skipped), fire for
`undefined`, and skip eager initializer side effects for `[null,0,false,'']`.

No new regressions: the full destructuring/default equivalence suite
(`array-rest-destructuring`, `basic-destructuring`, `binding-null-guard`,
`default-parameters`, `destructuring-extended`, `destructuring-initializer`,
`destructuring-member-targets`, `destructuring-type-coercion`,
`externref-array-destructuring`, `for-of-*`, `null-destructuring`,
`rest-params-call`, `test262-dstr-patterns`) shows the same 5 failures on this
branch as on `origin/main` (pre-existing: nested-destructuring-with-defaults,
destructured-function-parameters-with-defaults, and 3 plain default-parameter
cases — all unrelated f64-sentinel / nested-default issues, not touched here).

Known residual (out of scope, representational): a struct field whose TS type
is exactly `null` (degenerate literal type with no annotation/union) cannot
distinguish JS `null` from `undefined` at the wasm level. Real test262 cases use
`any`/union-typed fields (externref or ref_null), which are all handled.
test262 conformance delta validated by CI.

## Out of scope

- Function name inference (`init-fn-name-*`) — tracked by #1450.
- IteratorClose semantics when initializer throws — tracked by #1454.
- `length` property of param-bearing functions — tracked by #1364.
- Class method param destructure shape (`*list-err*`) — tracked by #1451.

## Test files to verify (sample)

```
test/language/statements/function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js
test/language/statements/function/dstr/dflt-obj-ptrn-id-init-skipped.js
test/language/expressions/arrow-function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js
test/language/expressions/function/dstr/dflt-obj-ptrn-id-init-skipped.js
test/language/expressions/generators/dstr/dflt-ary-ptrn-elem-id-init-skipped.js
test/language/expressions/async-generator/dstr/dflt-obj-ptrn-id-init-skipped.js
test/language/statements/class/dstr/gen-meth-dflt-obj-ptrn-id-init-skipped.js
test/language/statements/class/dstr/async-gen-meth-static-obj-ptrn-prop-id-init-skipped.js
test/language/expressions/object/dstr/meth-dflt-ary-ptrn-elem-id-init-skipped.js
test/language/statements/{let,const,variable}/dstr/*-init-skipped.js
test/language/statements/for/dstr/let-ary-ptrn-elem-id-init-skipped.js
test/language/statements/for-of/dstr/let-ary-ptrn-elem-id-init-skipped.js
```
