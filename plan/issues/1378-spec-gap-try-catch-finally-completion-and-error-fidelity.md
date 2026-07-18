---
id: 1378
title: "spec gap: try/catch/finally — RESCOPED to error-type fidelity only (Error-subclass own-field/prototype substrate)"
status: ready
created: 2026-05-08
updated: 2026-07-17
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: control-flow
goal: spec-completeness
sprint: Backlog
disposition: "senior-dev/Fable — deep externref-backed Error-subclass substrate (#2101/#1366). Sub-issues A (finally completion override) + C (catch destructure) are DONE on main; only B remains and it is NOT a try/catch bug."
---
# #1378 — try/catch/finally: completion values + error type fidelity

## RESCOPE (2026-07-17, re-validation against current main)

Re-validated all sub-issues against current `main` (dev-conform). **The only
remaining bug is sub-issue B (error-type fidelity), and it is NOT a try/catch
bug** — it is the deep externref-backed Error-subclass own-field/prototype
substrate. Re-tagged `feasibility: hard` + `disposition` (senior-dev/Fable);
kept out of the contained conformance fallback pool.

- **Sub-issue A (finally completion override) — VERIFIED FIXED on main.** All
  probes pass today: `(function(){ try{return 1}finally{return 2} })()` → 2;
  `try{return 1}finally{}` → 1; `try{throw 0}catch{return 2}finally{return 3}`
  → 3; finally-`break` override in a loop → correct. No work remaining.
- **Sub-issue C (catch destructure iterator semantics) — DONE** (merged earlier;
  `tests/issue-1378.test.ts` 4/4, see "Implementation Notes — sub-issue C").
- **Sub-issue B (error-type fidelity) — REMAINS, and is mis-filed as try/catch.**
  A user class `extends Error` yields, after `throw`/`catch`, a value with
  `typeof e === "string"`, `e.message`/`e.name` `undefined`, and `String(e)`
  TypeError-ing. Crucially it reproduces **with NO try/catch at all**:
  `new MyErr().name` (where `class MyErr extends Error { constructor(){ super();
  this.name = "MyErr"; } }`) already throws. Contrast: a plain class own-field
  (`class C{ x=42 }; throw new C()` → `e.x === 42`) and a builtin
  (`throw new RangeError("x")` → `e.name === "RangeError"`) both WORK. So the
  fault is the **externref-backed Error-subclass representation** — own fields
  set in the subclass constructor aren't persisted/readable, and the prototype
  chain isn't preserved (`e instanceof MyErr` → false). This is #2101 / #1366
  territory (subclass prototype chain + externref-backed own-field read), a
  hard substrate change, not the try/catch lowering this issue was filed under.

## Problem

`language/statements/try/*` — **99 fails**. 82 assertion_fail, 10 other, 3 null_deref, 2 type_error.

Spec §14.15 mandates:

1. **Completion override by finally**: if `finally` block has its own non-normal
   completion (return / break / continue / throw), it OVERRIDES the try/catch
   completion. Today `try { return 1 } finally { return 2 }` may return 1 instead
   of 2.
2. **Caught error type fidelity**: when V8 throws `RangeError`, our caught value
   must be a `RangeError` instance (with `name === "RangeError"`), not a generic
   `Error`. The `language/statements/try/dstr/ary-init-iter-get-err.js` test does
   `assert.throws(Test262Error, ...)` — it expects the user-thrown `Test262Error`
   to come back from `throw new Test262Error(...)` inside a try, not be replaced
   with the default Error class.
3. **destructuring binding TDZ**: `try { ... } catch ({ ...rest }) { ... }`
   binding pattern follows normal destructuring rules (#1363 territory but in
   catch context).
4. **`completion-values-fn-finally-normal.js`** (null_deref) — `try { … } finally { … }`
   should preserve the function's normal return value when finally runs.

Sample failing patterns:
- `try/12.14-14.js` — `(function() { try { return "test" } finally {} })()` returns "test".
- `try/dstr/ary-init-iter-get-err.js` — `try { throw new Test262Error() } catch (e) { …e is Test262Error… }`.
- `try/completion-values-fn-finally-normal.js` — null_deref in `assert_throws`.

## Acceptance criteria

1. `language/statements/try/12.14-14.js` passes (return value preserved).
2. `language/statements/try/dstr/ary-init-iter-get-err.js` passes
   (catch sees user-thrown Test262Error type).
3. `language/statements/try/completion-values-fn-finally-normal.js` passes (no null_deref).
4. `language/statements/try/dstr/obj-ptrn-prop-id-init-unresolvable.js` passes.
5. Pass-rate for `language/statements/try/` rises from ~50% to ≥80%; **+60 net passes**.

## Files to modify

- `src/codegen/statements.ts` — try/catch/finally lowering.
- `src/codegen/destructuring-params.ts` (if used) or the catch-binding emitter —
  destructuring in catch clause.
- `src/runtime.ts` — exception-tag carries error class info.

## Implementation Plan

### Root cause

#### A. Finally completion override

Wasm `try_table` doesn't directly support "if finally returns, the outer try's
return is overridden". We must emit explicit checks:

```wasm
(block $end_try
  (block $finally_normal
    try_table (catch $exn_tag $catch)
      <try-body>      ;; may set $tryResult, $tryWantsReturn = 1
      br $finally_normal
    end
  $catch:
    <catch-body>      ;; may set $tryResult, $tryWantsReturn = 1
  )
$finally_normal:
  <finally-body>      ;; if this returns / throws, override $tryResult
  ;; if finally completed normally and $tryWantsReturn, return $tryResult
)
```

The current emission may unconditionally use the try-block's result.

#### B. Error type fidelity

In `src/runtime.ts`, the exception-tag holds an externref. When user throws
`new RangeError("...")`, the externref IS a RangeError — that's correct. The bug
is likely in how WE construct exceptions: when user writes
`throw new Test262Error()`, the constructor lookup may resolve to a plain Error.

Verify:
- `Test262Error` is defined in test harness; user code does `throw new Test262Error(...)`.
- We construct an instance of Test262Error (host call) and pass it as the externref.
- `catch(e)` rebinds `e` to the externref.
- `e instanceof Test262Error` reads the prototype chain.

If `e instanceof Test262Error` fails, the prototype chain isn't preserved.

Fix: ensure `compileNewExpression` for any user-defined class produces an instance
whose `[[Prototype]]` is `Cls.prototype`. This is the same machinery as #1366
(subclass prototype chain).

#### C. Destructuring in catch

For `catch ({ a, b }) { ... }`:

- Allocate locals for `a`, `b`.
- The catch-tag value is the bound exception (externref).
- Emit destructuring as if it were a parameter pattern.

Current emission may emit `local.set $catchVar` with the whole exn, then NOT
destructure. Fix: in `compileCatchClause`, after `local.set`, run the
destructuring emitter on the bound name.

### Edge cases

- `try { throw 5 } catch (e) { … }` — `e` is `5` (the number, externref-boxed).
  `typeof e === "number"`.
- `try { return 1 } finally { … no return … }` — return 1.
- `try { return 1 } catch (e) { return 2 } finally { return 3 }` — return 3.
- `try { throw e1 } finally { throw e2 }` — outer sees e2; e1 is suppressed.
- `try { } finally { for (;;) break; }` — finally completes normally, no override.
- Async function with try/finally inside — same semantics, just lowered into
  generator state machine.

### Test262 sample

- `test262/test/language/statements/try/12.14-14.js`
- `test262/test/language/statements/try/dstr/ary-init-iter-get-err.js`
- `test262/test/language/statements/try/completion-values-fn-finally-normal.js`
- `test262/test/language/statements/try/dstr/obj-ptrn-prop-id-init-unresolvable.js`
- `test262/test/language/statements/try/completion-values-fn-finally-throw.js`

### Estimated impact

+60 passes; cleaner foundation for #1347 (for-of IteratorClose) and async error
handling.

## Implementation Notes — sub-issue C only (2026-05-08)

This PR addresses **only sub-issue C — catch destructuring iterator semantics**.
The remaining sub-issues (finally completion override, error type fidelity)
are tracked but not addressed here.

### Root cause (catch destructure)

`compileExternrefCatchDestructure` in `src/codegen/statements/exceptions.ts`
emitted property access (`__extern_get(exn, idx)`) for `catch ([x, y, ...])`
patterns. Per spec §13.3.3.6 IteratorBindingInitialization, array destructure
must invoke `GetIterator(value)` which calls `value[Symbol.iterator]()` —
property access silently misses `Symbol.iterator` and any throws from it.

### Fix

For `catch ([elements])`, emit `__array_from_iter(exn)` once, store the
materialised array in a fresh local, and read elements from the materialised
array via `__extern_get`. `__array_from_iter` (already used by parameter
destructure) walks the iterator protocol and propagates any throws from
`Symbol.iterator()` / `.next()` so spec-compliant tests like
`statements/try/dstr/ary-init-iter-get-err.js` see the inner Test262Error.

Empty-pattern `catch ([])` short-circuits with no materialisation per
§13.3.3.6 (no IteratorBindingInitialization steps).

## Test Results

- `tests/issue-1378.test.ts` — 4/4 pass
- `test/language/statements/try/dstr/ary-init-iter-get-err.js` — fail → pass
- No regressions on `try-catch-throw`, `try-catch-finally-extended`,
  `null-destructuring`, `global-index-shift-trycatch` test suites.

## Out of scope (filed as follow-ups)

- Finally completion override: `try { return 1 } finally { return 2 }` should
  return 2. Requires `try_table`-level lowering changes in
  `compileTryStatement` to track and conditionally override try-block
  completion based on finally completion type.
- Error type fidelity: `catch (e) { e instanceof Test262Error }` requires
  prototype-chain preservation when constructing user-defined error classes.
  Likely shares machinery with #1366 (subclass prototype chain).
- `completion-values-fn-finally-normal.js` null_deref: needs separate
  investigation of the `assert_throws` host shim.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
