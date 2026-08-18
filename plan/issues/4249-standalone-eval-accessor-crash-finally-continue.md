---
id: 4249
title: "Standalone ES5 wave 4: the eval-spliced accessor compiler crash, `catch{break} finally{continue}` at module scope, and the RegExp/exec remainder"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: object-literal-accessors, try-finally, regexp, eval
goal: es5
related: [993, 1858, 2061, 2923, 2939, 3633, 4230, 4233]
loc-budget-allow:
  # closures.ts +73: computeClosureWrapperSig's syntactic answer for
  # never-bound (eval-spliced) declarations — RC1 of this issue. Granted by
  # #4243's issue file while this PR stacked on the wave-3 branch; that file
  # is now on main, so the grant moves here.
  - src/codegen/closures.ts
func-budget-allow:
  # compileTryStatement +18: the catch{break}/finally{continue} fix threads the
  # finally-completion override through the existing try lowering — the branch
  # bookkeeping has to live inside the same function that owns the try/finally
  # block structure, so it cannot be split out without passing the whole label
  # context by reference.
  - src/codegen/statements/exceptions.ts::compileTryStatement
---

# #4249 — ES5-standalone wave 4: compiler crash + control-flow + RegExp remainder

Wave 4 of the ES5-standalone-90 % program
(`plan/goals/es5-standalone-90.md`), on top of waves 1–3 (#4220–#4234, #4243).

Baselines below are measured **on this branch's base** (waves 1–3 merged),
sequentially, via the `runTest262File` seam with `TEST262_TARGET=standalone`
under **Node 25** (Node 22's host RegExp rejects ES2025 modifier syntax during
early-error validation and manufactures phantom failures in these directories —
see #4233's "not wave-3 regressions" note).

| bucket | files | base pass | after | Δ |
| --- | --- | --- | --- | --- |
| `language/expressions/object` | 12 | 0 (7 compile_error) | **5** (0 CE) | **+5** |
| `language/statements/try` | 8 | 0 | **4** | **+4** |
| `built-ins/RegExp/prototype/exec` | 15 | 6 | 6 | 0 |
| `built-ins/RegExp` (residue) | 35 | 9 | 9 | 0 |
| `language/types/object` | 13 | 1 | 1 | 0 |

**Standalone total: +9, zero regressions** (both untouched RegExp buckets
re-measured identically after the change). The two fixed buckets were also
A/B'd on the **gc** lane against the unmodified sources:

| bucket (gc lane) | base | after |
| --- | --- | --- |
| `language/expressions/object` | 6 | 6 (unchanged — see RC1) |
| `language/statements/try` | 3 | **7** (+4 collateral) |

The try fix helps both lanes; the accessor fix is standalone-only by
construction (the gc lane never reached the crashing query).

## Root cause 1 — an eval-spliced object-literal ACCESSOR crashed the compiler

`Internal error compiling expression: Cannot read properties of undefined
(reading 'declarations' | 'escapedName') (at src/codegen/closures.ts:1569)` —
7 compile errors in `language/expressions/object` alone, and the crash class is
generic (it kills the whole file, not just the expression).

The eval-inline lifter (`src/codegen/expressions/eval-inline.ts`) parses the
eval string with a bare `ts.createSourceFile` and splices the result into the
program. Those nodes were never **bound**, so they carry no `symbol` and every
checker query resolving through one *throws* instead of returning `undefined`.
`allNodesInlineSupported` exists precisely to bail on the node kinds whose
codegen reaches the checker — but it lists function/arrow expressions and
classes and **misses object-literal accessors**, which
`emitObjectLiteralAccessorFn` (`literals.ts`) feeds to `compileArrowAsClosure`
through an `as unknown as ts.FunctionExpression` cast. So
`eval("o = {get foo(){…}}")` reached `getSignatureFromDeclaration` on an unbound
node and took the compile down.

**Widening the eval bail list would have been the wrong fix**, and measurably
so: on the **gc** lane the same splice compiles fine (it routes to
`compileArrowAsCallback`, which asks the checker nothing) and **5 of these 12
files PASS through it** (`11.1.5_6-3-1/2`, `7-3-1/2`, `4-4-b-1`, measured). A
blanket bail would have traded a standalone crash for a gc regression.

**Fix** — `declarationIsUnbound` + `unboundClosureReturnsAValue` in
`src/codegen/closures.ts`: `computeClosureWrapperSig` answers a never-bound
declaration **syntactically** instead of asking the checker. That is also the
semantically right answer, since such a body is untyped JS: every parameter is
`any` (externref) and the return is externref iff the body contains a
value-carrying `return` (nested functions are not descended into — their
`return`s are not ours). Concise arrow bodies and generators always yield a
value.

Measured: `language/expressions/object` **0 → 5 pass, 7 → 0 compile_error**;
the gc lane is unchanged at 6 pass (verified by re-running the same 12 files
with `TEST262_TARGET` unset).

## Root cause 2 — `catch { break; } finally { continue; }` fell out of the loop

The `S12.14_A9/A10/A11/A12_T4` family (do-while / while / for / for-in ×
`try{break}` and `catch{break}`, each with `finally{continue}`). CHECK#1 passed,
CHECK#2 failed with `"finally" block must be evaluated` — the counter ended at
`c2 = 3, fin2 = -1`, i.e. control fell through **past** the try into the loop
body's tail instead of continuing.

Minimal repro (module scope is load-bearing — inside a function the same source
takes the IR path and is correct):

```js
var n = 0;
while (n < 5) { n += 1; try { throw "x"; } catch (e) { break; } finally { continue; } n += 100; }
// n must be 5; was 101
```

The finally body is pre-compiled **once** at `+1` (the try block's label level)
and cloned into each control-flow path; `finallyInlineDelta`
(`statements/control-flow.ts`) retargets a clone by `current − baseline` using
the depth baselines stored on the `finallyStack` entry. The catch-body entry
snapshotted its baselines **after** the extra `+1` for the inner try that wraps
the catch body (so the finally also runs on a catch-body throw) — so the
baseline read `+2`, matched the break site exactly, and every break/continue
inside a catch body inlined the finally at **delta 0, one label too shallow**.
The cloned `continue` then branched to the enclosing **try** instead of the
loop, which exits the try and runs the statements after it. The sibling
catch_all insertion sites already pass an explicit `cloneFinallyAtDepth(1)` for
exactly this reason; the derived-delta site is the one that got it wrong.

**Fix** — snapshot `breakDepthBaseline` / `continueDepthBaseline` **before** the
inner-try `+1` in `src/codegen/statements/exceptions.ts`, so the baseline names
the depth the clone was compiled at.

Measured: `language/statements/try` **0 → 4 pass**, zero regressions in the
try/finally suites (`finally-block`, `finally-duplicate`, `issue-1858`,
`issue-2061`, `issue-2903`, `issue-2906-3c`, `issue-2906-gap3`, `issue-993`,
`try-catch`, `issue-2623`). The 5 pre-existing `finally-block.test.ts` failures
and the 2 in `issue-2623-p7-finally-bridge.test.ts` were A/B'd against the
unmodified file and fail identically on the base.

## Diagnosed, NOT fixed (leftovers with the mechanism named)

- **`exec`/`test` brand guard on four receiver shapes (8 files:
  `S15.10.6.2_A2_T4/T6/T8/T10` + the `S15.10.6.3_A2_*` `test` twins).** Each is
  a *different* subsystem, which is why #4233 deferred them and why they are not
  one fix. Re-measured on this base, `RegExp.prototype.exec` transferred onto:
  - `new String("[a-b]")` — returns instead of throwing (wrapper-exotics lane);
  - `new Number(1)` called as `o["exec"](s)` — the element-access call never
    routes to the native closure at all;
  - `Object.prototype.exec = …` then a primitive receiver — same, via the proto;
  - a bare `exec("s")` — **does** throw, but a *primitive* value, not a
    `TypeError` (`e instanceof TypeError` and `e.name` both answer falsy), so
    the closure's brand-recovery prologue is not what runs.

  The plain-object and Boolean-wrapper receivers (pinned in
  `tests/es5-standalone-regexp.test.ts`) are correct — the prologue itself is
  fine; the four failures are all call-site *routing*, upstream of it.
- **`obj.prop++` where the property holds a non-number (3 files:
  `S8.6_A2_T1`, `A2_T2`, `A3_T1`).** `{foo:"bar"}` lowers to a closed struct
  whose `foo` field is a string ref; the struct arm of `compileMemberIncDec`
  (`expressions/unary-updates.ts`) coerces the f64 result **back to the field
  type** and writes `null`. §13.4 requires the property to become the *number*
  NaN, which that slot cannot represent — so the real fix is a representation
  decision (widen the slot, or route a mixed slot to the externref RMW arm that
  already exists for `any` receivers), not a coercion tweak.
  `numeric-property-analysis.ts` already records `forcedNumeric` for these
  writes but withdraws the slot because the initializer is a string.
- **`language/types/object` remainder** — `S8.6_A4_T1` is the for-in
  overlay-enumeration lever (#4230 L1/L2), `S8.6.2_A5_*` are `this`-as-global
  writes, `S8.6.2_A1/A2/A8` are prototype-chain/extensibility semantics. None
  share a root cause with the above.
- **`S12.14_A14`, `A18_T6`, `A18_T7`** — throwing/catching a non-`Error` object
  or array and then reading properties off the caught value
  (`Cannot access property on null or undefined`). A catch-binding
  representation gap, unrelated to the finally-depth fix.
- **`12.14-7`** — needs a `ReferenceError` from an unresolvable reference.

## The biggest lever found and NOT taken: standalone throws error STRINGS

`typeErrorThrowInstrs` (`src/codegen/property-access.ts`) throws a **native
string** whose text merely *begins* with `"TypeError: "`, not a `TypeError`
object. Every `catch (e) { … e instanceof TypeError … }` and every `e.name` /
`e.message` read against it therefore answers falsy. Measured against the ES5
standalone failing set (`.tmp/es5-buckets.json`, 1,077 files):

| signature | failing ES5 files |
| --- | --- |
| `TypeError: Cannot access property on null or undefined` (the raw string) | 23 |
| `(e instanceof TypeError) … Expected SameValue(«false», «true»)` | 19 |

That is **42 files** touching one representation decision — larger than any
remaining item in this issue's own buckets. It is visible from here because
`built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T10` (bare `exec("s")`) fails
*exactly* this way: the inline dynamic-dispatch fallback cannot match the
native-proto method's `(self, this, arg)` funcref against its two 2-param
candidate arms, falls to the "no arm" path, and throws that string. Confirmed
from the emitted WAT — the argument `"m"` is even passed in the `this` slot.

Deliberately **not** changed here: it is a generic path used everywhere, the
blast radius is the whole suite rather than these buckets, and it belongs to the
`error-model` goal, not to an ES5-bucket wave. The two sub-levers are
independent and should be sized separately:

1. mint a real `TypeError` (`__new_TypeError`, which the standalone RegExp
   backend already uses) instead of a string — mechanical, wide;
2. register native-proto method closures as dispatch candidates so a bare or
   element-access call reaches the brand-recovery prologue at all — this is the
   same gap behind `A2_T6`/`A2_T8` above.

## Permanent repro

`tests/issue-4249-eval-accessor-and-finally.test.ts`.
