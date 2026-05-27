---
id: 1552
title: "spec gap: catch parameter destructuring (`try/dstr`) — share dstr-binding helper with function decls"
status: done
created: 2026-05-20
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: try-catch, destructuring
goal: spec-completeness
sprint: 52
parent: 779
related: [1432, 1450, 1454, 1550]
note: "Verified 2026-05-21: catch-clause codegen lives in src/codegen/statements/exceptions.ts (compileTryStatement at L242) — NOT statements.ts as cited"
---
# #1552 — `try { ... } catch (pattern) { ... }` — destructuring residuals

## Problem

ECMA-262 §14.15.2 `CatchClauseEvaluation`:

```
Catch : catch ( CatchParameter ) Block
  5. Let status be the result of performing BindingInitialization for
     CatchParameter passing thrownValue and catchEnv as arguments.
```

`BindingInitialization` is the same algorithm used for function-parameter
destructuring — so a fix in `destructuring-params.ts` should automatically
apply here. But **58 test262 cases** under `test/language/statements/try/dstr/`
still fail with `assertion_fail`, indicating the catch path either:

1. Has its own diverged copy of the destructure lowering, OR
2. Routes through the shared helper but the `thrownValue` it passes is the
   wrong shape (e.g. always wrapped as an externref while the helper expects
   either a struct ref or `__get_undefined()` for missing).

Sample failures:

| Test | Pattern | Symptom |
| --- | --- | --- |
| `ary-ptrn-elem-id-init-fn-name-fn.js` | `catch ([fn = function(){}])` | `fn.name` not 'fn' |
| `obj-ptrn-id-init-fn-name-cover.js` | `catch ({cover = (function(){})})` | name not set |
| `ary-ptrn-elem-obj-prop-id.js` | `catch ([{u:v}={u:444}])` | nested default fires when shouldn't |
| `obj-ptrn-prop-id-init-unresolvable.js` | `catch ({x:y=unresolvableRef})` | doesn't throw ReferenceError |
| `ary-ptrn-rest-obj-prop-id.js` | `catch ([...{0:v,1:w,length:z}])` | numeric+length key mix |
| `obj-ptrn-prop-ary-trailing-comma.js` | `catch ({x:[,]})` | trailing-comma elision |
| `ary-ptrn-elem-id-iter-step-err.js` | `catch ([x])` with iter step err | error swallowed |
| `obj-ptrn-rest-skip-non-enumerable.js` | `catch ({...rest})` | rest includes non-enumerable |
| `ary-ptrn-elem-id-iter-val-array-prototype.js` | `delete Array.prototype[@@iterator]` | doesn't throw TypeError |
| `obj-init-null.js` | `catch ({} = throw null)` | destructure null doesn't throw |

These exactly mirror the function-decl `dstr-binding` test family. The catch
path needs the same fixes already landing for #1450 (fn-name), #1454 (iterator
protocol), #1550 (init-skipped), and #1432 (rest with object pattern).

## Failure count

**58 tests** in `test/language/statements/try/dstr/` (all
`assertion_fail`). Estimated unlock after fix: ~50.

## Root cause

In `src/codegen/statements.ts` (or wherever `compileTryStatement` lives),
the `catch (CatchParameter)` arm probably emits a direct
`local.set $caught` for the simple identifier case and an inline
destructure-loop for the pattern case, instead of delegating to the
shared helper used by function declarations.

The fix is to route the pattern path through the **same**
`destructureParamArray` / `destructureParamObject` helper used by
function declarations:

1. Allocate a synthetic local of type externref for `thrownValue`.
2. Call the helper as if `thrownValue` were the function's sole argument.
3. The helper then handles defaults, fn-name inference (#1450), iterator
   protocol (#1454), `init-skipped` semantics (#1550), and rest patterns
   uniformly.

Once this routing is done, ~80% of the 58 fails resolve as ripple from
the existing/landing sibling issues. The remaining ones (probably
`obj-ptrn-rest-skip-non-enumerable` and trailing-comma edge cases) need
focused fixes in the helper itself.

## Acceptance criteria

1. `test/language/statements/try/dstr/ary-ptrn-elem-obj-prop-id.js` passes.
2. `test/language/statements/try/dstr/obj-ptrn-prop-id-init-unresolvable.js`
   passes (ReferenceError thrown when initializer references unresolvable).
3. `test/language/statements/try/dstr/obj-ptrn-rest-skip-non-enumerable.js`
   passes (non-enumerable property NOT copied into rest object).
4. `test/language/statements/try/dstr/ary-ptrn-elem-id-init-fn-name-fn.js`
   passes (cross-check with #1450).
5. `test/language/statements/try/dstr/obj-init-null.js` passes (TypeError
   when destructuring `null`).
6. `test/language/statements/try/dstr/` `assertion_fail` count reduces
   by **≥ 40** after rebasing on #1450 / #1454 / #1550 (which should land
   first).
7. `tests/issue-1552.test.ts` with one focused case per shape.

## Implementation plan

### Step 1 — find the catch-pattern emitter

```bash
grep -nR "compileTryStatement\|catchClause\|CatchParameter\|catchParam" src/codegen
```

The branch likely lives in `src/codegen/statements.ts` near the
`try` / `catch` lowering. Identify whether catch-pattern destructure
calls the shared `destructureParam*` helpers or has its own loop.

### Step 2 — route to the shared helper

```ts
// Pseudocode, inside compileCatchClause:
if (catchParam.type === 'Identifier') {
  // existing simple-identifier path
} else {
  // Pattern path: synthesize a fake "argument" record and call the shared helper
  const thrownLocal = ctx.addLocal('__thrown', 'externref');
  emit(Op.local_set, thrownLocal);

  // Re-use the same helper signature as function params:
  destructureParam(ctx, catchParam, thrownLocal, { isCatch: true });
}
```

`destructureParam` (or whatever the shared entry point is called) MUST:
- Honour `init-skipped` (#1550): only fire initializer when value is `=== undefined`.
- Apply fn-name (#1450): set `name` on anonymous initializer values.
- Use IteratorRecord protocol (#1454): GetIterator → step → close.
- Throw `TypeError` when the value being destructured is `null` /
  `undefined` (catch-binding never receives undefined per spec since
  `thrownValue` is whatever was thrown, but a thrown `null` IS valid input
  and destructuring `null` throws `TypeError` per §7.3.20).

### Step 3 — rest with non-enumerable

For `catch ({...rest})`, `CopyDataProperties(rest, thrownValue, excludedNames)`
must skip non-enumerable own properties. Check the existing
`__copy_data_properties` runtime helper — if it enumerates
`Object.getOwnPropertyNames(...)` rather than `Object.keys(...)`, non-enumerable
will leak. Fix by switching to `Object.keys` (string keys) +
`Object.getOwnPropertySymbols` (symbol keys, also enumerable-filtered).
Be careful: this fix may help many other rest-pattern tests too.

### Step 4 — `tests/issue-1552.test.ts`

```ts
runCases('issue-1552 catch dstr', [
  ['obj-pattern',     `try{throw {a:1,b:2}}catch({a,b}){return a+'-'+b}`, '1-2'],
  ['ary-pattern',     `try{throw [1,2,3]}catch([a,b,c]){return a+b+c}`, '6'],
  ['default-skipped', `let n=0;try{throw {x:5}}catch({x=++n}){return x+'-'+n}`, '5-0'],
  ['default-fires',   `let n=0;try{throw {y:undefined}}catch({y=++n}){return y+'-'+n}`, '1-1'],
  ['rest-non-enum',   `let o={a:1};Object.defineProperty(o,'x',{value:9,enumerable:false});
                       try{throw o}catch({...r}){return JSON.stringify(r)}`, '{"a":1}'],
  ['null-throws',     `let kind='none';try{try{throw null}catch({}){}}catch(e){kind=e&&e.name||String(e)};kind`,
                      'TypeError'],
  ['fn-name',         `try{throw []}catch([fn=function(){}]){return fn.name}`, 'fn'],
]);
```

## Files to inspect

- `src/codegen/statements.ts` — `compileTryStatement` / catch clause.
- `src/codegen/destructuring-params.ts` — shared helper (re-use here).
- `src/runtime.ts` — `__copy_data_properties` (rest non-enumerable
  filtering).
- `tests/issue-1552.test.ts`.

## Dependencies

This issue is "easy" only if #1450 (fn-name), #1454 (iterator protocol),
and #1550 (init-skipped) land first — once those are routed through the
shared helper, this issue becomes "wire catch to the helper, fix the
non-enumerable bug, ship". If any of those sibling issues is in flight,
land them first to maximise ripple.

## Out of scope

- `catch` clause without binding (`catch { ... }`) — already supported.
- `try { } catch(e) { } finally { }` completion semantics — separate issue.

## Resolution (2026-05-27)

Most of the 58 fails had already resolved as ripple from the sibling issues
(#1450 fn-name, #1454 iterator protocol, #1550 init-skipped) landing — the
catch path was already routing non-empty patterns through the shared
`compileExternrefObjectDestructuringDecl` / `compileExternrefArrayDestructuring-
Decl` helpers. Re-running `test/language/statements/try/dstr/` (93 files) found
**92 pass, 1 CE** before this PR. The lone remaining CE
(`ary-ptrn-elem-id-iter-val-array-prototype.js`) is a TypeScript type-check
error from assigning a generator to `Array.prototype[Symbol.iterator]` — a
shared iterator-override typing gap, not catch-specific.

Two real behavioural gaps remained, fixed here:

1. **Object-rest non-enumerable leak** (`src/runtime.ts` `__extern_rest_object`):
   for WasmGC-struct sources the struct-field and sidecar copy loops did not
   consult the sidecar property-descriptor map, so a `defineProperty`-marked
   non-enumerable own property leaked into `catch ({ ...rest })`. Per
   ECMA-262 §14.7.4 CopyDataProperties only enumerable own properties are
   copied. Now filtered via `_wasmPropDescs` / `_SC_ENUMERABLE`. (Also fixes
   the same leak for `let { ...r } = obj` declarations.)

2. **Empty-pattern RequireObjectCoercible** (`src/codegen/statements/exceptions.ts`):
   `catch ({})` / `catch ([])` over a thrown `null` / `undefined` must throw
   TypeError (§8.5.2 / §8.5.3 begin with RequireObjectCoercible / GetIterator).
   The decl helper deliberately short-circuits empty patterns (to keep
   `let {} = null` behaviour per #1553c), so the catch path now emits the
   `emitExternrefDestructureGuard` coercibility check itself for empty
   patterns. A coercible value (object / array / number) still binds without
   throwing.

Acceptance criteria 1-6 verified; `tests/issue-1552.test.ts` extended with
non-enumerable-rest, empty-pattern null/undefined-throw, empty-pattern
coercible-no-throw, and fn-name cases (15 tests, all green).
