---
id: 6618
title: "A class constructor reached through a property-access method call (`ns.C()`) silently answered null instead of throwing TypeError, across the standalone link"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-16
assignee: ttraenkler/sendev-s31
---

# #6618 — a class called as a plain function must throw, even through `ns.C()`

## Problem

§10.2.1 [[Call]] step 2: *"If F's [[FunctionKind]] internal slot is
classConstructor, throw a TypeError exception."* Under `--target standalone`
this held for two of the three ways JS lets you reach a class VALUE
dynamically, and silently missed the third:

| shape | mechanism | base answer |
| --- | --- | --- |
| `C()` — resolvable identifier | `class-call-without-new.ts` (#4483) | throws |
| `const f = C; f()` — bare dynamic VALUE | `wantIsCallableGuard` (#6420, `expressions/calls.ts`) | throws |
| `ns.C()` — property-access method call, `ns` a linked provider's namespace | `__extern_method_call`'s resolved-callee guard (`resolved-callee-guard.ts`, #4656) | **silently answers `null`** |

test262 spells this `built-ins/Temporal/**/constructor.js` — **16 files**,
every one asserting `assert.throws(TypeError, () =>
Temporal.PlainDate(1970, 1, 2))` where `Temporal` is the linked
`@js-temporal/polyfill` provider's namespace object. 8 of the 16 already
passed (the `prototype/constructor.js` half, which asserts something
different — that the prototype's OWN `constructor` property is non-writable,
non-configurable). The other 8 — one per Temporal class — all failed
identically: `Test262Error: Expected a TypeError to be thrown but no
exception was thrown at all`.

## Root cause

`Temporal.PlainDate` is a PROPERTY of a provider-owned namespace object, so
the call reaches `__extern_method_call`'s `$Object` arm and resolves the
callee through `__extern_get`. `buildResolvedCalleeGuard` (the guard spliced
into that arm) only throws for the ABSENT case (`ref.is_null`) and for
provably-PRIMITIVE callees (`__typeof_number/string/boolean`) — deliberately,
per its own docstring, because a broad `!isCallable(v)` risks turning a
callable shape the classifier fails to recognise into a wrong hard throw. A
class VALUE is neither absent nor a primitive, so it fell through to
`__apply_closure`, which has no arm for a `$ClassName` struct and answers its
legacy `null` — the call silently "succeeds" with a nonsense return value
instead of raising.

Measured (`.tmp/s31/tp.mts`, driving `compileWithTemporalGlobal` directly —
the exact machinery `tests/test262-runner.ts` uses for a Temporal row):

```js
Temporal.PlainDate(1970, 1, 2);                          // "null" — the bug
(function(){ const f = Temporal.PlainDate; f(1,1,1); })() // throws TypeError — already worked (#6420)
```

The two lines differ ONLY in whether the class is called through a bare
VALUE or through the PROPERTY that names it — proving the defect is
specifically the method-call arm, not the class-callable classifier itself
(`__is_callable`/`__typeof_function`, which already correctly disagree on a
class both module-locally, via `classObjectIdentityArms`, and across the
link, via the `__js2wasm_link_callable_kind` boundary terminal's bit 0).

## Fix

`src/codegen/resolved-callee-guard.ts` — added a narrow, provably-safe arm to
`buildResolvedCalleeGuard`, alongside the existing primitive-brand checks:
when BOTH `__typeof_function` and `__is_callable` are already registered
(never force-imported — see "Emission discipline" below), throw when the
resolved callee is `typeof_function() && !is_callable()`.

**Why that predicate is safe** (the argument the file's docstring warns is
needed before touching the "absent-not-wrong" boundary): `__typeof_function`
and `__is_callable` share every classifier arm — closure wrapper, bound
function, proxy, revoker, branded builtin, the link-boundary `callableKind`
bit — except exactly one: `__is_callable` deliberately EXCLUDES a
class-constructor identity (`classObjectIdentityArms` module-locally, the
`callableKind` boundary bit 0 across the link) that `__typeof_function`
deliberately INCLUDES (§10.2.1 step 2's own "class constructors are
functions, but only [[Construct]]-able" rule). So
`typeof_function && !is_callable` can be true for **only** a class — any
value the callable classifier fails to recognise (the risk the file's
docstring names) is *equally* invisible to `__typeof_function`, since it is
built from the identical base arms, and the new check stays silent for it
rather than mis-throwing.

This is the CALL-side twin of #6612's `IsConstructor` guard
(`construct-is-constructor-guard.ts`): #6612 splices into the dynamic
CONSTRUCT driver, after every arm that answers for a callee WITH
[[Construct]] has declined; this splices into the dynamic property-CALL
arm, after every arm that answers for a callee WITH [[Call]] has declined.

## Result

Corpus-wide, the 16-file `constructor.js` family, per file, solo, 60s budget:

| label | pass | fail |
| --- | --- | --- |
| base | 8 | 8 |
| branch | **16** | **0** |

`0 pass→fail`. Four-family sample (`PlainDate`, `Duration`, `PlainDateTime`,
`ZonedDateTime/prototype`, first 120 files each, solo, 60s budget, fresh
`JS2WASM_TEMPORAL_CACHE`):

| family | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 109 | 110 | +1 | 0 | 1 (`constructor.js`) |
| `Duration/**` | 100 | 101 | +1 | 0 | 1 (`constructor.js`) |
| `PlainDateTime/**` | 111 | 112 | +1 | 0 | 1 (`constructor.js`) |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **423** | **426** | **+3** | **0** | **3** |

`ZonedDateTime/prototype/**` doesn't move because it has no `constructor.js`
of its own in that subtree (that file lives one level up, at
`ZonedDateTime/constructor.js`, part of the 16-file family above). No
`compile_error`, no `timeout`, no `__temporal_*` leak in any of the 960 rows.

Base measured by file-copy revert of `resolved-callee-guard.ts` to
`HEAD~1` on both labels.

## Controls — must-not-move, per file, both labels, 0 flips

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys`(30) + `expressions/object`(30) + `Reflect/{get,has}`(21) | 81 | 77 | 77 | 0 |
| B: `Object/{entries,values}`(41) + `getOwnPropertyNames`(30) + `for-in`(30) | 101 | 81 | 81 | 0 |
| C: `expressions/call`(92, all under 150) + `statements/class`(100) + `Function/prototype/call`(49) | 241 | 192 | 192 | 0 |

## Byte A/B

**Targeted** (`.tmp/s31/bytes.mts`, single-module synthetic sources, both
lanes):

| artifact | base | branch | |
| --- | --- | --- | --- |
| a class called via `ns.C()` (the armed case) | `56e1ddb9` 138,586 B | `599521d4` 138,628 B | **moved** (+42 B) |
| the same class called via a bare VALUE `f()` | `e6f9a465` 138,596 B | `01ba68ab` 138,593 B | moved (collateral, see below) |
| a plain function called via `ns.fn()` | `bc369b1d` 148,236 B | `741d3103` 148,278 B | moved (collateral) |
| a class with NO dynamic call site at all | `2f9ce04a` 49,715 B | identical | — |
| `new ns.C(...)` (construct, not call) | `38b79dd1` 138,448 B | `5daa35b0` 138,490 B | moved (collateral) |
| a plain-object method call, no class anywhere | `8377d4df` 52,698 B | identical | — |
| **every `gc`-lane artifact above** | | | **identical** |

**The collateral moves are real and expected, not a measurement artifact.**
`buildResolvedCalleeGuard`'s new arm is spliced into the SHARED
`__extern_method_call` native's body once, at `ensureObjectRuntime` build
time, whenever BOTH `__typeof_function` and `__is_callable` happen to
already be registered in that module — matching the file's own pre-existing
discipline for its primitive-brand checks (`ctx.funcMap.get`, never
`ensureLateImport`; see "Emission discipline" in the source). A module that
triggers `ensureObjectRuntime` with both natives present grows by the same
few dozen bytes regardless of whether ITS OWN call sites are classes, because
the guard lives in the shared function body, not per call site. The two rows
that stay byte-identical (`class with NO dynamic call` and `plain-object
method call`) are the modules where `__is_callable`/`__typeof_function`
happen not to be registered yet at that point — confirming the byte-neutral
case still holds where documented.

**Corpus** (`.tmp/s31/corpus.mts`, 42 `website/playground/examples` +
`tests/fixtures` modules × {gc, standalone} = 84 artifacts): 14 of the 42
standalone artifacts moved (same shared-helper-growth mechanism as above —
these are ordinary object-using modules, not class-through-method-call
cases); **every `gc`-lane artifact is byte-identical**, confirming the fix is
`noJsHost`-gated correctly. This is NOT a null control like prior slices'
corpus runs (S24–S30) — the collateral growth from a shared native's body
means "0 moved" was never going to be the honest number here, and reporting
it as such would misstate the finding.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures —
baseline exactly, on both trees.

**Witness**: `tests/issue-6618-class-through-method-call.test.ts`, 7 `it`s —
5 exercise the linked-pair shape this issue fixes (all measured failing on
base, passing on branch, via file-copy revert), 2 are module-local controls
(one records the honest base+branch-identical answer for a shape this slice
does NOT touch — `NS.C()` inside a SINGLE module reaches a different,
already-correct compile path, `class-call-without-new.ts`, and is unaffected
either way).

## What the hand-off got right and where it was narrowed

The brief's framing — "the CALL-side twin of #6612's IsConstructor guard" —
was exactly right and survived reduction intact; #6612's file
(`construct-is-constructor-guard.ts`) was the correct pattern to mirror, and
its `__typeof_function`-narrowing discipline (arm 1 of its "three
conservative narrowings") is the same discipline this fix borrows. The one
clause worth flagging: the brief scoped "the consumer's dynamic call arm" —
this turned out to be `resolved-callee-guard.ts`'s `__extern_method_call`
guard specifically, not `expressions/calls.ts`'s `tryEmitInlineDynamicCall`
(#6420's own arm, which already covered the bare-value-call shape and needed
no change).

## Traps

- **A single-module reduction can be the WRONG reduction.** `const f = C;
  f()` (module-local, bare value) already threw before this fix — reducing
  the corpus failure to that shape would have missed the defect entirely. The
  actual repro needs a MULTI-MODULE link (`.tmp/s31/pair.mts`/`tp.mts`), or a
  property-access callee even within one module compiled through
  `compileMulti` with a linked namespace stub — a same-module `NS.C()`
  compiled via `compile()` alone reaches yet a THIRD path
  (`class-call-without-new.ts`) that already worked, so it is not a
  reduction of this defect either. Three superficially similar one-liners,
  three different compile paths, only one of them broken.
- **The corpus byte A/B is not always a null control.** A change that grows
  a SHARED runtime native's body moves every artifact that registers that
  native with the right preconditions, whether or not the specific test
  exercises the new arm. Reporting "0 moved" here would have been false; the
  honest report is "14/42 moved, and here is why that is still correct."
