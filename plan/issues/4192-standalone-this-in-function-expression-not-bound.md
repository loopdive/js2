---
id: 4192
title: "`this` is dead inside a variable-held function EXPRESSION — .call/.apply/.bind and method invocation all drop the receiver (BOTH lanes)"
status: in-progress
created: 2026-08-06
updated: 2026-08-06
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/W13-builtin-proto-residue
sprint: current
horizon: l
related: [4025, 3983, 3796, 2152, 1636, 4163]
# Slice 1 (this PR): +31 LOC in calls.ts — the receiver-install plan + the three
# `finishClosureReceiverCall` sites. The mechanism itself lives in the new leaf
# module src/codegen/closure-receiver-install.ts; only the call-site wiring can
# live in the driver.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #4192 — `this` in a variable-held function expression is never bound

## Repro (both `--target standalone` AND the JS-host lane)

```js
var fe = function () { this.touched = true; };
var o1 = {}; fe.call(o1);        // o1.touched === undefined   (want true)
var o3 = {}; fe.apply(o3);       // o3.touched === undefined   (want true)
var o4 = {}; fe.bind(o4)();      // o4.touched === undefined   (want true)
var o5 = { m: fe }; o5.m();      // o5.touched === undefined   (want true)

var ge = function () { return this.v; };
ge.call({ v: 9 });               // NaN                        (want 9)

function fd() { this.touched = true; }   // a DECLARATION works
var o2 = {}; fd.call(o2); // o2.touched === true  ✓
```

Verified through `runTest262File(…, "standalone")` **and** the JS-host lane on
the same file — identical failure text, so this is **not** a standalone gap.

## Root cause (traced, then confirmed against the emitted WAT)

The receiver-install machinery is keyed on **`ts.isFunctionDeclaration`**:

- `resolveDeclaration` (`src/codegen/named-this-call.ts:94`) returns `undefined`
  for anything that is not a `FunctionDeclaration`, so
  `resolveNamedThisCallTarget` / `tryReshapeApplyToNamedThisCall` never fire.
- At the call site (`src/codegen/expressions/calls.ts`) the named-`this` arm is
  additionally gated on **`!closureInfo`**. `var fe = function (){}` registers a
  `closureMap` entry, so even the identifier form takes the `closureInfo`
  branch — the legacy *evaluate-`thisArg`-and-**drop**-it* lowering.

Same defect class #4025/#3983 fixed for declarations ("a silent wrong answer,
not a refusal"), left standing for the dominant JS shape.

**The lifted body needs no change.** WAT for the repro shows the closure opening
with `global.get $__current_this; ref.is_null; (if … $__undefined …)` — i.e.
`bodyReferencesOwnThis` was true, `compileFunctionBody` set `readsCurrentThis`,
and the body reads the global correctly. Nothing in the module ever *wrote* it:
`global.set` on `$__current_this` appeared only inside `__call_fn_method_N`,
which this path does not reach. Only the writer was missing.

## Slice 1 — LANDED: `.call` / `.apply` (this PR)

New leaf module `src/codegen/closure-receiver-install.ts`:

- `planClosureReceiverInstall` — admission. Fires only when the callee
  identifier resolves to a `VariableDeclaration` whose initializer is a
  **`FunctionExpression`** (arrows excluded: their `this` is lexical, and
  installing a dynamic receiver would *change* their meaning), non-generator,
  non-`async`, no explicit `this` parameter, and whose body
  `bodyReferencesOwnThis` — the same predicate the body used to decide it would
  read the global, so the two can never disagree.
- `emitClosureReceiverInstall` / `finishClosureReceiverCall` — inline
  save/install/restore around the call, mirroring `__call_fn_method_N`
  (closure-exports.ts) and `fillDirectCallTrampolines` (typed-this.ts),
  **including their documented limitation that an exceptional unwind skips the
  restore**. An inline sequence cannot use the trampoline's `catch_all` without
  wrapping an arbitrary sub-expression in a `try`; matching the established
  sequence exactly is worth more than being the one path that differs.

A **null** receiver needs no arm: the body's own `ref.is_null` guard already
answers `undefined`, so `f.call(null)` keeps the value it has today. That is
deliberately unlike `named-this-call.ts`, which must branch because its
trampoline passes the receiver as a parameter.

Reassignment of the variable is deliberately **not** checked. Unlike the
exact-target trampoline this install bakes no callee: if the variable holds some
other function at runtime, that function either reads `__current_this` (in which
case installing the spec receiver is correct) or does not (in which case the
install is unobservable).

### Measured

Base-vs-head, `--target standalone`, ES5 label, interpreter runtime-eval tier:

| corpus | base | head |
| --- | ---: | ---: |
| `built-ins/Function/prototype` (189 ES5 files) | 94 pass | **95** pass |
| 148-file corpus: every ES5 file using `.call(`/`.apply(` **and** a function expression, ∪ the `Array.prototype` HOF-`thisArg` family (the other `__current_this` consumer) | 84 pass | **86** pass |

**FIXED 2** (`Function/prototype/{apply,call}/S15.3.4.{3,4}_A5_T5.js` — literally
the repro), **BROKE 0**, zero signature changes among the still-failing. Two
apparent regressions in the first sweep were parallel-run compile timeouts and
pass when re-run serially.

Covered by `tests/issue-4192-fn-expr-this-call-apply.test.ts` (10 cases, each
asserted on **both** lanes). Verify-first: 6 of the 10 are RED on `origin/main`;
the 4 that are green on both are the guards that must not move (null receiver,
function declaration, arrow, callee that never mentions `this`).

The ES5 count is small because only 43 ES5 files use this shape at all. The
value is host-lane correctness in the dominant JS function form, not the
conformance delta.

## Remaining (NOT this PR)

1. **Method invocation** — `var o = { m: fe }; o.m()` still drops the receiver.
   Different call path (`call-receiver-method.ts`), same missing install. This
   is the commonest shape and worth the most.
2. **`.bind`** — `fe.bind(o)()` still drops it; the `$__bound_fn` carrier
   (#3140) is a third path. It is also entangled with the 34-file
   `Function.prototype.bind` bucket (construct-through-`bind`,
   `<Builtin>.bind(null)`), which wants its own issue.

## Coordination

W12 is concurrently implementing the 168-file 10.4.3 `this`-binding cluster
(sloppy-mode `this` falling through to `emitUndefined` regardless of strictness)
in `src/codegen/expressions.ts`. **Different mechanism, adjacent territory.**
This slice touches neither `expressions.ts` nor the body's `this` lowering — it
only adds the missing *writer* of `__current_this` at one call site. The two
compose: W12 decides what a body reads when nothing is installed; this decides
what gets installed.
