---
id: 5178
title: "Tag-dispatch cascade types every arm from the first override's struct — `HelperBase_calendarToIsoDate` fails WebAssembly.compile"
status: done
completed: 2026-08-29
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: hard
task_type: bugfix
area: codegen, classes
goal: dogfood
related: [4628, 5169, 4644, 4645, 4646, 5179, 5180]
assignee: ttraenkler/opus-dev-5178
---

# #5178 — a virtual-dispatch arm pushes its own struct into a block typed for another

## Problem

With #4644, #4645 and #5169 applied, the full 157 KB `@js-temporal/polyfill@0.5.1`
+ `jsbi@4.3.0` linked bundle compiles with **zero hard diagnostics** and
`success: true`, and the emitted binary is still rejected:

```
Compiling function #277:"HelperBase_calendarToIsoDate" failed:
type error in fallthru[0] (expected (ref null 109), got (ref null 142)) @+305667
```

Same family as #4644, which fixed the **arity** divergence in the same cascade.
This is the **result-type** divergence one signature field over. `compile()` is
not the gate for either.

## Root cause

`emitVirtualMethodDispatchByTag` (`src/codegen/expressions/virtual-dispatch.ts`)
lowers a polymorphic `this.m(…)` into a cascade of `if`s, one per candidate
override, each arm calling that override's own body. It derived the cascade's
block type from the **first candidate alone**:

```ts
const wasmRet = getWasmFuncReturnType(ctx, firstCand.funcIdx);
resultType = wasmRet ?? resolveWasmType(ctx, retType);
```

and then handed that one type to every arm's `if`. Overrides are not obliged to
agree. `HelperBase.estimateIsoDate` has **seven** implementations across the
calendar hierarchy returning **five** distinct object-literal structs — read
straight off the emitted WAT:

| implementation                            | Wasm result   |
| ----------------------------------------- | ------------- |
| `HebrewHelper_estimateIsoDate`            | `ref null 109` |
| `IslamicBaseHelper_estimateIsoDate`       | `ref null 109` |
| `PersianHelper_estimateIsoDate`           | `ref null 142` |
| `IndianHelper_estimateIsoDate`            | `ref null 23`  |
| `GregorianBaseHelperFixedEpoch_estimateIsoDate` | `ref null 23` |
| `GregorianBaseHelper_estimateIsoDate`     | `ref null 23`  |
| `ChineseBaseHelper_estimateIsoDate`       | `ref null 97`  |

The cascade declared `(ref null 109)` (the Hebrew arm, first in the candidate
list) and the Persian arm pushed `(ref null 142)`. Not a subtype relation:
these are unrelated object-literal structs, `109` being
`(struct (mut externref) (mut (ref null 94)) (mut externref))` and `142`
`(struct (mut (ref null 102)) (mut (ref null 5)) (ref null 141))`.

**No global indices and no `#4646` class-identity interaction are involved** —
the hypothesis in the dispatch note was that same-named class identities had
been confused. They had not. The producer is one line of return-type inference
that reads a single candidate where it must read all of them.

Two adjacent latent defects in the same function, found while reading it:

* the schema signature was read from `cand.funcIdx` while the arm actually
  calls `funcMap.get(...)`'s index — the exact mismatch #4644's parameter half
  had already fixed for parameters but not for results; and
* `callBody` returns `[]` when it cannot build an arm, and the cascade dropped
  that empty array into a `then` whose block type declares a value, leaving the
  cascade one operand short.

## Reproduce

```bash
DOGFOOD_TEMPORAL_POLYFILL=1 node node_modules/vitest/dist/cli.js run \
  tests/dogfood/temporal-polyfill.test.ts
```

or, minimized (`tests/issue-5178-virtual-dispatch-result-type.test.ts`): four
subclasses whose `estimate` overrides each return a differently-shaped object
literal, consumed by a base method. The override bodies must be padded past the
inlining threshold — a small override is inlined before the cascade's block
types matter, and the un-padded reduction is green on the buggy compiler, which
is why this was not caught by the existing class tests.

## Fix

`src/codegen/expressions/virtual-dispatch.ts` — unify the cascade's result type
across **all** candidates, reading each one's signature off the index the arm
will actually `call`:

* all arms agree → keep that type (the common case, unchanged);
* all arms return internal (`any`-side) refs → widen the cascade to `externref`
  and `extern.convert_any` each arm's value. That conversion is a pure
  representation change with no import behind it, so it is safe to emit inside
  an arm array — unlike boxing, which would emit a `call` there and hit the
  late-import index-shift hazard #4644's padding comment rules out;
* anything else (mixed void/value, numeric-and-ref, `funcref`) → decline
  transactionally and let the caller use the static path, rather than emit a
  module the engine refuses.

Also: read the first candidate's result off `funcMap`'s resolved index, and
refuse an empty arm body instead of emitting it.

Every new bail-out replaces an **invalid module**, so none of them can regress a
case that previously worked.

## Verification

* **Full linked bundle: `WebAssembly.compile()` OK** on the tree this fix was
  developed against (`fc6fd3b5f3` + #4644 + #4645 + #5169). 157,541 source
  bytes, ~40 s compile, 0 hard diagnostics (2 IR-fallback warnings, both
  pre-existing), binary accepted. Nothing was left behind #5178 on that tree —
  this closes the *validate* blocker the lane was stuck on.
* **The lane is NOT green on current `main`, for an unrelated reason.** After
  re-merging `origin/main` (`bdb19824b0`) the bundle no longer produces a binary
  at all: `Binary emit error: RangeError: Codegen error: struct field index out
  of range — 1 (valid: [0, 1)) at function 'JSBI___toPrimitive'`. Measured with
  AND without this fix, and on a scratch worktree of **plain `origin/main`** —
  present in all three, so it is neither caused nor masked by #5178. Filed as
  **#5180**; it entered `main` between `fc6fd3b5f3` and `bdb19824b0`.
* `tests/issue-5178-virtual-dispatch-result-type.test.ts` — 4 tests. The two
  reductions fail on this branch's base (`type error in fallthru[0]` and, in
  return position where tail-call optimization turns the arm into
  `return_call`, `return_call: tail call type error`) and pass with the fix. The
  homogeneous control asserts the cascade still dispatches to each subclass's
  own body, so a "fix" that flattened the cascade could not pass.
* Scoped A/B against the branch base on `class-*`, `issue-1299`, `issue-4644`,
  `issue-4645-dispatch-chain-size`, `issue-4646`, `issue-5169`: 80 tests, the
  same 3 failures before and after — **no new failures**. Those 3 are
  `tests/issue-1299.test.ts`'s dict-dispatch cases, which are **already red on
  `origin/main`** (verified in a scratch worktree at `fc6fd3b5f3`); unrelated to
  this change and unrelated to the three merged dependency branches.

## Known residual — filed as #5179

Widening a heterogeneous dispatch to `externref` makes the module valid; it does
not make every *consumer* read it back. Where the caller stores the result in a
variable whose TypeScript type is the base's declared return type, the existing
guarded-downcast idiom (#1917) `ref.test`s that one struct and substitutes
`ref.null` for anything else, so a subclass with a different shape reads as
`null` and the next property access throws
`TypeError: Cannot access property on null or undefined`.

This does **not** affect the polyfill (`u` there is already an `externref`
local, so nothing narrows) and it is not a regression — before this fix the
same programs produced a module that could not be instantiated at all. The
narrowing is a consumer-side gap, not a dispatch gap; see #5179.

## Stacking

Branched from `origin/main` (`fc6fd3b5f3`) with `origin/issue-4644-call-thunk-arity`,
`origin/issue-4645-superlinear-compile` and `origin/issue-5169-immutable-global-jsbi`
merged in — all three are prerequisites for reaching this failure and none were
on `main` at the time. #4644 has since landed (PR #5187) and deduplicated; #4645
and #5169 are still in flight (PRs #5188 / #5212).

While this issue was in progress, #5188 was dequeued with `MERGE_CONFLICT`
against the selfhost/ES2015 merges. That conflict was resolved on **#5188's own
branch** by this lane at the coordinator's request (commit `d15d666c64`) — the
selfhost PR had independently rewritten the same dispatch arms with an
instruction-identical single-`next` shape, so #4645's `buildShapeGuardedArm`
helper was kept and main's additions in those files preserved. This branch then
re-merged the updated #5188 branch and `origin/main`, both cleanly.
