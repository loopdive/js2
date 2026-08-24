---
id: 4660
title: "js-host: .constructor on a user-shadowed intrinsic error resolves the intrinsic carrier inside a frame-driven async body"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
related: [4648, 4626]
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
trap-growth-allow:
  count: 16
  reason: "Stale-baseline reclassification carried from merged PR #4794 (realm shim #4634): 16 cross-realm tests that were ALREADY failing null-deref instead of failing an assertion. Named per #3596; failure-flavour reclassification only. Inert once the baseline re-promotes."
  tests:
    - test/built-ins/AsyncFunction/proto-from-ctor-realm.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Function/internals/Call/class-ctor-realm.js
    - test/built-ins/Function/internals/Construct/derived-return-val-realm.js
    - test/built-ins/Function/internals/Construct/derived-this-uninitialized-realm.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Proxy/apply/arguments-realm.js
    - test/built-ins/Proxy/construct/arguments-realm.js
    - test/language/eval-code/indirect/realm.js
    - test/language/expressions/async-generator/eval-body-proto-realm.js
    - test/language/expressions/generators/eval-body-proto-realm.js
    - test/language/expressions/tagged-template/cache-realm.js
    - test/language/types/reference/get-value-prop-base-primitive-realm.js
    - test/language/types/reference/put-value-prop-base-primitive-realm.js
files:
  - src/codegen/expressions/identifiers.ts
---

# js-host: `.constructor` resolves the intrinsic inside a driven async body

Split out of #4648 (PR #4801, merged), whose agent isolated this as an
independent fifth root cause and recommended its own issue. It is the last
async-family harness self-test failure in the js-host lane.

Goal context: 100% of `test/harness/` in BOTH lanes. Measured on main
`16eba04e8` with the quickjs provider built: standalone **115/116**, js-host
**102/116**; PRs #4803 and #4801 have since landed (js-host ≈110), #4804 is
queued (≈113).

## Symptom

`test262/test/harness/asyncHelpers-throwsAsync-custom-typeerror.js` fails with
`assert.throwsAsync did not reject a collision of constructor names`: the two
`throwsAsync` calls that must REJECT resolve instead, because
`thrown.constructor` answers the INTRINSIC `TypeError` rather than the test's
local `function TypeError() {}`.

## Discriminator (from #4648, verify before designing)

Both js-host, both under `asyncTest`:

```js
// (a) outer async body WITHOUT any await → e.constructor === TypeError  (CORRECT)
asyncTest(async function () {
  function TypeError() {}
  var e = new TypeError();
  throw new Test262Error("" + (e.constructor === intrinsic));   // false
});

// (b) outer async body WITH an await → e.constructor === intrinsic  (WRONG)
asyncTest(async function () {
  function TypeError() {}
  var e = new TypeError();
  await Promise.reject(e).then(null, function () {});
  // e.constructor === intrinsic → true
});
```

The `await` is the discriminator: it makes the body **frame-driven** (the async
body is split across resume points with locals spilled to a frame).

**Construction is already correct** — `e instanceof intrinsic` is FALSE in (b),
so the shadow guard `errorCtorNameIsUserShadowed` fires and the right
constructor runs. Only the `.constructor` READ resolves the wrong carrier.

## Implementation Plan

1. **Reproduce (b) as a standalone probe first**, js-host lane, before touching
   codegen. Vary: with/without `await`; `.constructor` read before vs after the
   await; the shadowing declaration hoisted vs not. The goal is to pin whether
   the wrong carrier is chosen at the READ site or baked when the local is
   spilled to / restored from the frame.
2. Locate the `.constructor` read path and the carrier precedence in
   `src/codegen/error-ctor-carrier.ts`; compare what it consults in a plain body
   versus a driven body. A driven body's local restore is the prime suspect: if
   the spilled value's static type or carrier tag is recorded from the intrinsic
   family rather than the user fnctor, the read after resume looks it up in the
   wrong table.
3. Fix so the carrier follows the VALUE, not the name-keyed intrinsic family,
   across a resume boundary. Do not special-case `TypeError` or the harness.
4. Check the standalone lane for the same defect (standalone is at 115/116 and
   this test passes there — establish WHY before changing shared code, so the
   fix does not flip it red).

## Acceptance criteria

- `asyncHelpers-throwsAsync-custom-typeerror.js` passes js-host.
- Full js-host harness category improves by exactly this test, no regressions.
- Full standalone harness category unchanged.
- js-host 60-sample and the equivalence gate clean.

## Diagnosis (measured 2026-08-23, main `d821d9618`)

**The `.constructor` read was never the defect, and neither was the frame
spill.** Both were downstream of a wrong *identifier* read: inside the driven
body, the plain identifier `TypeError` — the shadowing `function TypeError() {}`
read as a VALUE — evaluated to the **intrinsic host constructor**. Everything
else follows: `new TypeError()` registers the fnctor instance against that wrong
carrier, and `.constructor` faithfully hands it back.

### How it was pinned

The `#4648` discriminator does not reproduce in isolation — a bare
`await Promise.resolve(1)` in the async body is NOT sufficient. Measured
js-host, all four in one file (`.tmp/probe/k.js`, `local === intrinsic`
should always be `false`):

| probe | shape | result |
| --- | --- | --- |
| k1 | shadow captured by an **async IIFE that is invoked** | `true` ← BUG |
| k2 | shadow captured by an async fn expr, **invoked** via a var | `true` ← BUG |
| k3 | shadow captured by a **sync** nested fn, invoked | `false` ok |
| k4 | shadow captured by an async fn expr, **never invoked** | `false` ok |

So the discriminator is: *a nested **async** function that captures the shadow
and is actually reached*. That is what forces the enclosing body through the
frame-driven lowering (`$__async_resume_<fn>`) — which is where the #4648 agent's
"frame-driven" intuition was right, but the mechanism is not spilling.

`.tmp/w.mts` dumping the two WATs makes it exact. In the working case (k4) the
read resolves to the cached fn-closure singleton:

```wat
(global.get $global$3)   ;; lazily = (struct.new $0 (ref.func $__fn_tramp_TypeError_cached) …)
```

In the broken case (k1), inside `$__async_resume_fk1`, the SAME source read
becomes:

```wat
(call $global_TypeError)   ;; the ambient host intrinsic, via __declared_global_TypeError
```

### Root cause

`compileIdentifierCore` (`src/codegen/expressions/identifiers.ts`) consults
`ctx.declaredGlobals` — the ambient host-global registry populated by
`collectDeclaredGlobals` (`extern-declarations.ts` ~L1582, `AMBIENT_BUILTIN_CTORS`
gated on a bare value use, which `var intrinsicTypeError = TypeError` supplies).
That map is **name-keyed and module-wide, with no shadow check at all**.

Every arm placed ABOVE it that models shadowing — `fctx.localMap`,
`ctx.capturedGlobals`, `ctx.moduleGlobals` — is *also* name-keyed, and the first
is per-`FunctionContext`. The funcref-as-value arm that owns user function
declarations sits ~300 lines BELOW the ambient arm. So the ambient arm is the
de-facto shadow adjudicator, and it only ever adjudicated correctly by accident:
in ordinary bodies the read is served earlier (as a local, or reused from the
value materialised into a closure struct). A body re-hosted into
`$__async_resume_*` has neither, the read reaches the ambient arm, and the
intrinsic wins.

`ctx.standalone` is excluded from that registration (extern-declarations.ts
L1606, `#2907`) — **that, and nothing about the standalone async lowering, is
why the standalone lane already passed this test.** Verified before changing
shared code.

### Fix

One guard at the ambient arm: ask the checker who the identifier denotes
(`ctx.oracle.valueDeclarationOf`) instead of trusting the name. Skip the ambient
global when the identifier resolves to a **function declaration in a real source
file** whose own name matches, and `ctx.funcMap` holds a **defined** (non-import)
function for it — the last clause guarantees the funcref arm downstream will
serve the read, so it can never degrade from "wrong object" to the
`ref.null.extern` graceful default. Not special-cased to `TypeError` or to the
error family; the whole `AMBIENT_BUILTIN_CTORS` list is covered.

### Deliberately not done

The deeper defect — a driven body losing the binding for a hoisted nested
function declaration, so `localMap`/`capturedGlobals` cannot see it — is
untouched. It is invisible for any name that is not also an ambient global
(nothing else claims it, so the funcref arm serves), which is why this narrow
guard is sufficient. If a shadow of a non-function kind (`var TypeError = …`)
in a driven body ever shows the same symptom, that is the issue to open.

## Progress

- Root cause pinned and fixed in `src/codegen/expressions/identifiers.ts`
  (`ambientGlobalReadIsUserFunctionShadowed`). `status: done`.
- Validation numbers are in the PR description.

## Permanent repro

`test262/test/harness/asyncHelpers-throwsAsync-custom-typeerror.js` (js-host
lane, `tests/test262-runner.ts` `runTest262File(..., undefined)`).
