---
id: 6504
title: "Linked lane: `await thenable` yields the thenable instead of its resolved value — and pre-#6492-r6 the resulting failure was reported as a PASS"
status: in-progress
sprint: current
created: 2026-09-18
updated: 2026-09-18
priority: high
horizon: m
feasibility: hard
task_type: bug
area: runtime
language_feature: async-await
goal: test262-conformance
related: [6492, 3451, 5226]
# 2026-09-18 (round 29) — the spill continuation for `o.m(await x)`.
# `src/codegen/async-frame.ts` +24: the spill-name collection loop in
# `computeAsyncSpills` (the continuation's frame fields are not source
# bindings, so `plan.liveAfterAwait` cannot supply them) plus the
# `allowSpilledCall` argument at the three `planLinearAwaits` call sites that
# must agree about which shapes exist. It cannot move to the new subsystem
# module: it is the frame-layout builder's own list, and splitting it would put
# half of one layout decision in two files.
# The MECHANISM itself is a new module — `src/codegen/async-spilled-call.ts`
# (plan + both emit halves) — so the god-files take only the wiring.
loc-budget-allow:
  - src/codegen/async-frame.ts
---

# #6504 — two defects, one row

Five rows were attributed to #6492 round 6's `lastCaughtException` move
(`ea9bb68887`), on a 3×-stable A/B: revert that one line and they pass. The
attribution is correct and the conclusion drawn from it was not. Round 19
instrumented **both arms** of the A/B on
`language/expressions/await/await-awaits-thenables.js`, run solo, logging every
host-import throw (with import name, depth and import-object id) and every
latch read:

```
pre-fix arm  (latch per import object)
  [R19 throw] obj=0 import=__extern_method_call_2 depth=2 [object Error] Expected SameValue(«[object Object]», «42») to be true
  [R19 read]  obj=1 -> undefined
  → 1 pass, 0 fail

post-fix arm (latch module-scope)
  [R19 throw] obj=0 import=__extern_method_call_2 depth=2 [object Error] Expected SameValue(«[object Object]», «42») to be true
  [R19 read]  obj=1 -> [object Error] Expected SameValue(«[object Object]», «42») to be true
  → 0 pass, 1 fail
```

**Line 1 is identical in both arms.** The assertion fails either way: `await
thenable` yields the thenable (an object) where the test expects `42`. The only
divergence is the single read by the OTHER import object, and therefore whether
that already-real failure is reported.

So `ea9bb68887` did not regress these rows. It **unmasked** them.

## ROOT CAUSE (#6492 round 23, instrumented): `planLinearAwaits` declines an await in a CALL ARGUMENT

Instrumenting `asyncFnNeedsHostDrive`'s decision points on the row's exact body:

| source | awaits | anyRealSuspension | `planLinearAwaits` | `computeTryCatchSpills` | verdict |
| --- | --- | --- | --- | --- | --- |
| `assert.sameValue(await thenable, 42)`, `assert` undeclared | 1 | true | **NULL** | **NULL** | DECLINE |
| same, `assert` defined locally | 1 | true | **NULL** | **NULL** | DECLINE |

Identical — so this is **lane-independent** and unrelated to the link seam, the
call target's resolvability, or thenables. `planLinearAwaits` returns `null` for
an `await` nested as an argument of a call; with no try/catch,
`computeTryCatchSpills` is `null` too; the decline means the legacy synchronous
pass-through, which compiles `await` as a **no-op**.

`await thenable` is just the shape that makes the erasure visible: a thenable
comes back unchanged and the assertion catches it.

**Fix (scoped in #6492 round 25):** `planLinearAwaits` already HAS a bounded
call-argument arm, `replaySafeNestedCallAwait` (`src/codegen/async-cps.ts`
~L594). Our rows miss it by design: it requires the callee to be a plain
identifier bound by a single `const` declaration, and ours is the property
access `assert.sameValue`.

The arm works by RECOMPILING the containing statement after resume, which is
sound only because the pre-suspension work is one immutable binding read.
Admitting a member-expression callee would re-read it after the suspension — and
the awaited thenable's `then` runs arbitrary code in between — so that trades a
silently-erased `await` for a silently-re-read callee.

The real fix is the spill path the module's own doc names ("explicit pre-await
operand spills rather than continuation recompilation"):

1. a synthetic frame binding for the **callee value** (plus the receiver for
   `o.m(...)`), evaluated before the suspension and spilled;
2. spills for every **preceding argument**, in evaluation order;
3. a resume path that CALLS the spilled callee with the spilled arguments and
   the delivered value, instead of recompiling the statement;
4. the same for `new C(await x)` and for an await nested inside an argument
   expression (`f(1 + await x)`), where the partial operand is spilled too.

Today's `resumeBinding` / `asyncAwaitValueLocals` machinery delivers exactly one
value into a recompiled statement; (1)–(4) are a different continuation ABI and
are the whole of this issue plus #6502's 3 rows.

**Resolved (#6492 round 24 item 1): the honest lane is NOT false-passing these
rows.** Measured on `await-awaits-thenables.js` solo, instrumented: the honest
lane FAILS it (the assertion throws, the reason survives, verdict red), and the
row is not in the 138-row honest-pass/linked-fail set at all. The honest
135/138 is therefore not overstated by these rows and needs no correction. Both
lanes produce the wrong value; only the pre-r6 linked lane hid it.

## Superseded round-22 note: the CALL TARGET (incorrect)

Round 21's consumer observation is right (the `await` is not lowered) but its
A/B was not: the single-module arm used `var r = await thenable; return r;`
while the row's body is `assert.sameValue(await thenable, 42)`. Compiling the
ROW's shape single-module reproduces the erasure.

| source | Promise imports |
| --- | --- |
| `var r = await thenable; return r;` single module | **yes**, all four |
| `assert.sameValue(await thenable, 42)`, `assert` UNDECLARED, single module | **none** |
| same, `assert` defined locally | **yes** |
| same, linked consumer (`assert` is a provider import) | **none** |

The async engine's verdict turns on whether the awaited expression's enclosing
**call target is resolvable in this unit**. The linked lane is hit because
`assert` is a provider import, which lands in the same class as an undeclared
identifier — and the honest lane passes because there `assert` is a compiled
function in the same unit.

**Next step:** `asyncFnNeedsHostDrive` (`src/codegen/async-frame.ts` ~L231)
declines; its early exits are ruled out (`awaitIsStaticallyResolved` is false for
a bare identifier), leaving `planLinearAwaits(...) === null` then
`computeTryCatchSpills(...) === null`. Instrument those two across the three
sources above, find which needs the call target's type, and stop an
unresolvable / cross-unit target from forcing a decline. Separately: a decline
should arguably refuse loudly rather than emit a no-op `await`.

## Round 21's observation (still valid): the consumer erases `await`

Dumping the real linked-seam compile (`compileHarnessLinkedBody`, `emitWat`),
`$foo` is an ordinary **void** function whose `await` is not lowered at all —
the operand is read and handed straight to `assert.sameValue`:

```wat
(func $foo (type 10)                  ;; no result
  …  global.get 10  extern.convert_any  local.set 1   ;; the THENABLE, read directly
  …  call 7)                                          ;; assert.sameValue(thenable, 42)
```

Across the whole consumer module: **0** host Promise imports, **0** native
thenable substrate (`__promise_has_callable_then` / `__promise_thenable_job`),
**0** `__async_*` artefacts. So this is not a thenable-unwrapping gap and not a
wrong host-free-floor verdict — the async machinery is absent.

`$foo` being void is also what #6502 was chasing from the other side (a closure
whose funcref is `func(ref, externref) -> ` with no result; `foo()` answering
`null`, so `asyncTest`'s `testFunc().then` threw). **#6502's three `await` rows
and these five are one defect.**

**Fix location:** the predicate that leaves a body unit without async lowering.
The single-module compile of the same body takes the host route (imports
`Promise_resolve`, `Promise_new_pending`, `Promise_settle_{resolve,reject}`,
`Promise_then2_frame`); the linked consumer takes neither route. Suspects in
order: `entryScriptGoal` (#6474), the `deferTopLevelInit` window (#6477), and
`asyncFnNeedsHostDrive`'s pre-body verdict running without the harness prefix in
view. `.tmp/r9/linkedwat.mts` dumps the consumer WAT for any row.

## Defect A — the symptom

On the linked lane, `await thenable` produces the wrong value:

```js
async function foo() {
  var thenable = { then: function (resolve) { resolve(42); } };
  var res = await thenable;
  assert.sameValue(res, 42);   // res is [object Object]
}
```

Present in both arms, unrelated to the latch. The five affected rows:

- `language/expressions/await/await-awaits-thenables.js`
- `language/expressions/dynamic-import/assignment-expression/await-expr.js`
- `language/expressions/optional-chaining/iteration-statement-for-await-of.js`
- `language/expressions/optional-chaining/member-expression-async-identifier.js`
- `language/expressions/optional-chaining/optional-chain-async-square-brackets.js`

### ELIMINATED (#6492 round 20): it is not `_wrapThenable`

The obvious starting point — `_wrapThenable` (`src/runtime.ts`) deciding whether
a compiled struct carrying a `then` is mirrored before `PromiseResolve` sees it,
with its probes answering for the wrong module (#5225) — was implemented
(decode through `_decoderExportsFor`) and measured: **still 5 failed**.

Instrumented on `await-awaits-thenables.js` solo, the reason is categorical:

| probe | fired? |
| --- | --- |
| `_wrapThenable` entry (struct AND not-a-struct arms) | **never** |
| `Promise_resolve` import lambda | **never** |
| `Promise_then2_frame` import lambda | **never** |

The linked consumer's `await` reaches **none** of the host Promise imports,
although a single-module compile of the same body imports `Promise_resolve`,
`Promise_new_pending`, `Promise_settle_{resolve,reject}` and
`Promise_then2_frame`. So the awaited value is resolved by some other mechanism
in the linked consumer — the wasm-side frame engine
(`src/runtime/wasmgc/async/frame-engine.ts`) being the obvious candidate.

**Next step:** dump the linked consumer's import list and `__async_*` locals for
this row and diff against the single-module compile above; find what drives the
await there, then apply the owner-exports idea to THAT reader. The idea is right
in kind (a cross-module value read with the wrong module's exports); only the
reader was misidentified.

## Defect B — a false PASS, already fixed by r6

Pre-r6 the cross-module rejection reason was lost (`undefined`), and a failing
async row reported as **passing**. That is the worse of the two defects: it is
silent, and it inflates conformance. `ea9bb68887` fixed it.

**Therefore: do NOT revert `ea9bb68887`.** Reverting re-hides five real
failures and additionally loses r6's seven genuine cross-module-throw gains
(`SharedArrayBuffer/prototype/slice` ×3, `RegExp/prototype/Symbol.matchAll` ×3,
`RegExpStringIteratorPrototype/next`). The correct accounting is that the linked
lane's headline was 5 too high before r6.

## Acceptance criteria

- `await` of a cross-module thenable resolves to the thenable's resolved value,
  with the 5 rows passing on the linked lane.
- r6's 7 rows and `tests/issue-6492-r6-cross-module-host-throw.test.ts` stay
  green; honest stays 135/138.
- A regression test asserts the **reason** survives a cross-module async
  rejection — the false-pass shape is invisible to any row-count check, so it
  needs its own assertion.

## Round 29 (2026-09-18) — the spill continuation is IMPLEMENTED; one of the five rows is fixed

`src/codegen/async-spilled-call.ts` implements the ABI this issue named. Full
write-up, measurements and the deliberate scope boundaries are in #6492's
`## Round 29`. Summary:

| slice | lane | before | after |
| --- | --- | --- | --- |
| six async slices (2,212 rows) | linked | 1,532 | **1,533** (+1 / −0) |
| six async slices (2,212 rows) | honest | 1,526 | **1,530** (+4 / −0) |
| 138-row #6492 set | linked | 49 | 49 (+0 / −0) |

`language/expressions/await/await-awaits-thenables.js` — the row this issue was
filed on — **passes on both lanes**. The honest lane also gained the three
`async-function/named-reassign-fn-name-in-body*` rows: a named function
expression whose own name binding is reassigned in its body is exactly the
"callee is not an immutable binding" case the replay arm must refuse.

### Defect A should be SPLIT — the other four rows are a different bug

Re-measured individually on the linked lane after the fix:

| row | verdict | error |
| --- | --- | --- |
| `await/await-awaits-thenables.js` | **pass** | — |
| `dynamic-import/assignment-expression/await-expr.js` | fail | `SameValue(«undefined», «"Te…»)` |
| `optional-chaining/iteration-statement-for-await-of.js` | fail | `[object Object] is not iterable` |
| `optional-chaining/member-expression-async-identifier.js` | fail | `Cannot read properties of null` |
| `optional-chaining/optional-chain-async-square-brackets.js` | fail | `SameValue(«0», «undefined»)` |

None of the four is an erased `await` in a call argument. Three are optional
chaining (`?.`), which the new planner declines by name because `a?.b()` has its
own short-circuit semantics; one is dynamic `import()`. They were grouped here
because they failed alongside the thenable row, not because they share its
cause. They need their own diagnosis.

### Still open in this issue

- `new C(await x)` — needs a `[[Construct]]` resume op; `__call_function_<n>`
  would silently perform a `[[Call]]`.
- `f(1 + await x)` — the await nested INSIDE an argument (the round-26 census's
  12-event `nested-operand` bucket): same ABI, the partial operand must be
  spilled too.
- try/catch ACROSS the await — the try/catch planner's states carry no spill
  hooks, so `lowerChunk` deliberately does not admit the shape; it keeps its
  pre-round-29 behaviour. `tests/issue-6504-spilled-call-await.test.ts` pins
  that boundary.
- The **loud refusal** half. Plan for the flag-diff run (no event-to-row
  attribution needed — that failed in round 28 because vitest batches worker
  stderr):
  1. gate the widening behind an env flag in
     `reportDeclinedAsyncRejectionHazard` (`src/codegen/async-activation.ts`):
     drop the `findSuspensionInsideTry` condition for declines with
     `anyRealSuspension` true, keeping the existing scope;
  2. run the six async slices on the linked lane with the flag ON;
  3. diff against the round-29 baseline (1,533 / 2,212 — the baseline MOVED this
     round, so no earlier run can be reused);
  4. ≤ 20 distinct rows flipping pass → fail ⇒ land it and list them here;
     > 20 ⇒ list them for follow-up and land nothing.
