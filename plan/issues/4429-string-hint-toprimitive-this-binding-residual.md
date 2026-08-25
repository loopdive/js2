---
id: 4429
title: "String-hint ToPrimitive drops the receiver `this` — `'' + a` / `String(a)` call toString with wrong this (in-tree #2679 tests failing)"
status: done
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
loc-budget-allow:
  # emitWithCurrentThis + the three wrapped dispatch arms live at the existing
  # string-hint sites in the coercion engine; extracting them would split the
  # __current_this save/install/restore across modules mid-dispatch.
  - src/codegen/type-coercion.ts
area: codegen
es_edition: 5
language_feature: to-primitive
goal: standalone-gap
related: [2679, 4426]
origin: "2026-08-15 ES5-standalone session — tests/issue-2679-toprimitive-this.test.ts has 2 failing cases, reproduced identically at merge-base 63785cb (silent regression of the #2679 fix, string-hint half)."
---

# #4429 — string-hint ToPrimitive drops the receiver `this`

## Problem

Two cases of the COMMITTED test `tests/issue-2679-toprimitive-this.test.ts`
fail on current main (vitest, no test262 involved):

- `'' + a` calls `toString` with `this === a` → expected 1, got 0
- `String(a)` calls `toString` with `this === a` → expected 1, got 0

for `var tv; var a = { toString() { tv = this; return "x"; } }`. The
`@@toPrimitive` and every NUMBER-hint case in the same file pass — the
number-hint dispatch installs `__current_this` around the call
(`type-coercion.ts` ~3153, the #2679 fix); the string-hint path was
documented there as "static-dispatches the raw method with the receiver as
param-0, was correct", which is evidently no longer true. test262 tests are
not the trigger here but the same defect underlies `Object.prototype`-level
`toString` receivers across the ES5 standalone `object-to-primitive`
bucket (36 ES5 rows).

## Implementation Plan

1. Reproduce: `npm test -- tests/issue-2679-toprimitive-this.test.ts` —
   2 failures expected. These are vitest tests; fastest loop available.
2. The string-hint dispatch emitters live in `src/codegen/type-coercion.ts`:
   - `tryStructPrimitiveToString*` (~line 180–290): the toString-first
     OrdinaryToPrimitive(string) static dispatch — closure-ref arm (~225,
     `emitGuardedFuncRefCast` + `call_ref`) and eqref candidate-chain arm
     (~280).
   - `tryStructToString` (~3496) and its `normaliseToString`.
   Determine which arm the test's shape takes (object-literal method → the
   `__obj_meth_tramp_*` trampoline reads `this` from the `__current_this`
   GLOBAL, not param-0 — the exact mechanism the number-hint fix (#2679)
   documents at ~3132). The probable root cause: object-literal methods
   moved to trampolines after the string-hint path was written, so the
   "receiver as param-0" claim silently rotted.
3. Fix: mirror the #2679 `__current_this` save/install/restore around the
   string-hint dispatch arms (both closure-ref and eqref chains), reading
   `ctx.currentThisGlobalIdx` FRESH at each global op (the ~3156 comment
   documents the mid-dispatch global-shift hazard — copy that discipline,
   and note the #4426 session restructured the number-hint candidate chain
   at ~3082, so diff against that shape, not the pre-#4426 one).
4. Sanity: whole `tests/issue-2679-toprimitive-this.test.ts` green (13/13);
   `tests/es5-standalone-callable-tostring.test.ts` and
   `tests/issue-4208-ordinary-to-primitive-ir.test.ts` stay green; scoped
   standalone run over `language/types/object|built-ins/Object/prototype`
   for flips in the object-to-primitive bucket.

## Acceptance criteria

- All 13 cases of `tests/issue-2679-toprimitive-this.test.ts` pass.
- No regression in the ToPrimitive-adjacent suites named above.

## Root cause

The suspicion in step 2 of the plan was right. Object-literal methods are stored
as `__obj_meth_tramp_*` trampolines whose FIRST instruction is
`global.get $__current_this` — param-0 is the closure self/env, not the
receiver. The string-hint dispatch emitters `call_ref` that trampoline directly
and never installed the global, so the trampoline read whatever `__current_this`
happened to hold. The "static-dispatches the raw method with the receiver as
param-0, was correct" claim at `type-coercion.ts` ~3157 rotted silently when
object-literal methods moved to trampolines.

Both failing cases take the SAME arm — `tryStructStringHintExternrefDispatch`,
eqref candidate chain (verified from the emitted WAT: `__primitive_host_eq_*`
locals, trampoline reading global `$__current_this`). `String(a)` and `'' + a`
funnel through it identically, which is why one fix closes both.

The standalone (native-strings) lane was worse than "wrong `this`": there
`__current_this` is NULL at the dispatch, so the trampoline's `ref.cast` trapped
at runtime — `RuntimeError: dereferencing a null pointer` for **any**
`this`-reading `toString`, not just identity-sensitive ones. Verified by A/B on
`{ x: 7, toString() { return "v" + this.x; } }`: trap before, `"v7"` after.

## Fix

New `emitWithCurrentThis(ctx, fctx, receiverLocal, resultType, emitDispatch)`
helper in `src/codegen/type-coercion.ts` — save `__current_this`, install the
receiver (`extern.convert_any` of the struct), run the dispatch, capture the
result, restore, re-push. Applied to all three string-hint dispatch arms:

- `tryStructStringHintExternrefDispatch` — wraps the primary+secondary
  OrdinaryToPrimitive attempt (this is the arm both failing tests take).
- `tryStructPrimitiveToStringAsExternref` — closure-ref arm and eqref
  candidate-chain arm.

It reads `ctx.currentThisGlobalIdx` FRESH at every global op and never caches it
across the sub-emission (the #2679/#2078 mid-dispatch global-shift hazard), and
degrades to the plain dispatch when the global was never registered.

Also mirrored the #4426 candidate-chain restructure into
`tryStructPrimitiveToStringAsExternref`'s eqref chain: zero-capture closure
wrappers canonicalize to one struct type, so a passing `ref.test closureTypeIdx`
does not prove the stored funcref has that candidate's signature. A signature
miss now falls through to the next candidate instead of manufacturing
`ref.null` + `ref.as_non_null` and trapping.

## Test Results

| Suite                                            | Before          | After           |
| ------------------------------------------------ | --------------- | --------------- |
| `tests/issue-2679-toprimitive-this.test.ts`      | 13/15           | **15/15**       |
| `tests/issue-4429-string-hint-toprimitive-this.test.ts` (new) | 1/5 | **5/5** |
| `es5-standalone-callable-tostring` + `issue-4208-ordinary-to-primitive-ir` + `es5-standalone-number-format` | 33/33 | 33/33 |
| 13-file ToPrimitive/toString sweep                | 114/116         | 114/116         |
| 12-file `tests/equivalence/` coercion subset      | 82/82           | 82/82           |

(The issue text says "13 cases"; the file actually holds 15 — 13 passed, 2
failed. Both now pass.)

The 2 remaining failures in the sweep are `issue-2638-toprimitive-class-arm`
(class-instance `__to_primitive` arm) and are **pre-existing on this base** —
confirmed by an A/B revert of `type-coercion.ts` alone.

New regression test `tests/issue-4429-string-hint-toprimitive-this.test.ts`
pins the STANDALONE lane (uncovered by the #2679 file, which is JS-host only),
including a nesting case that asserts `__current_this` is RESTORED so coercing
an inner object does not clobber an enclosing method's `this`. It fails 4/5 on
the pre-fix compiler.

## Residuals

- **`tv === a` still fails in STANDALONE** for `var tv; ...toString(){ tv = this; }`.
  This is object IDENTITY across the struct→externref materialization, not the
  `this` binding — the same probe reading `this.x` returns the right value. The
  JS-host cases (the ones the issue names) pass.
- **`tryStructToString`'s own section-1 arms** (ref-field ~3610, eqref-field
  ~3647) still `call_ref` a trampoline without installing `__current_this`.
  Left alone deliberately: instrumented probes over method-shorthand,
  function-expression, valueOf-only and prototype-toString shapes never reach
  them (the wrapped `tryStructStringHintExternrefDispatch` delegation at ~3496
  claims all of them first), so wrapping them would be unexercised code.
- **No test262 flips measured** in a 19-file `language/types/object` standalone
  spot-check or a targeted `this`-in-`toString` sample — byte-identical
  before/after. Those buckets fail on other gaps (property attributes, `with`).
  The conformance win, if any, is in rows whose `toString` reads `this`; CI's
  merge_group run is the real measurement.
