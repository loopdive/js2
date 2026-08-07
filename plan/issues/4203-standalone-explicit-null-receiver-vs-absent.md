---
id: 4203
title: "Standalone substrate: codegen cannot distinguish an EXPLICITLY-null receiver from an absent one — `f.bind(null)()` / `f.call(null)` in strict code answer `undefined` where the spec says `null` (12 measured files, §10.4.3)"
status: ready
created: 2026-08-07
updated: 2026-08-07
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
sprint: current
horizon: m
related: [4196, 4192, 3140, 2106]
origin: "W21 (§10.4.3 residue census) handed the file list to W19 (#4196); W19 measured it on branch issue-4196-bind-construct, 2026-08-07"
---

# #4203 — "no receiver" and "receiver is `null`" are the same value in standalone

## The gap

`__current_this` holds `ref.null.extern` for **both** "no receiver was
installed" and "the caller explicitly passed `null`". The callee body's
`ref.is_null` guard therefore answers `undefined` in both cases. §10.4.3 says a
**strict** callee must observe the receiver **exactly as passed** — `null` stays
`null` — while a sloppy callee substitutes the global object. Without a
boundness signal the two are indistinguishable and the strict rows cannot pass.

This is a **substrate** defect, not a `bind` defect. It sits under at least
three surfaces (`.bind`, `.call`, `.apply`) and two clause families.

## Measured (standalone, INTERPRETER runtime-eval tier, 2026-08-07)

All 12 fail on `origin/main` and on `issue-4196-bind-construct`
(#4196 slice 1 is [[Construct]]-only and does not touch this):

| files | shape | observed |
| ---: | --- | --- |
| 4 | `test/language/function-code/10.4.3-1-77{-s,gs}.js`, `-79{-s,gs}.js` | `f.bind(null)() !== true`; `f.bind(o)() !== true` |
| 2 | `…/10.4.3-1-80{-s,gs}.js` | `f.bind(this)()` → `SameValue(«undefined», «[object Object]»)` |
| 2 | `…/10.4.3-1-98{-s,gs}.js` | sloppy declaration bound by a strict caller |
| 2 | `…/10.4.3-1-67{-s,gs}.js` | `f.apply(null) !== true` |
| 2 | `…/10.4.3-1-72{-s,gs}.js` | `f.call(null) !== true` |

The `gs` twins all report the harness's `'this' had incorrect value!`, i.e. the
same defect surfaced through the global-scope variant.

Canonical minimal case (`10.4.3-1-77-s.js`):

```js
function f() { "use strict"; return this === null; }
assert(f.bind(null)());
```

## The substrate is CLOSER than "no signal exists" suggests

Two representations already in the tree do most of the work:

1. **There is already a distinct externref `undefined`** — the `#2106`
   `undefinedSingleton` regime (`undefinedSingletonActive`,
   `emitUndefinedExtern`, `__extern_is_undefined` in `src/codegen/any-helpers.ts`),
   active exactly when `ctx.standalone || ctx.nativeStrings`. So the
   externref plane can distinguish `undefined` from `null` **today**; the two
   collapse only because `__current_this`'s "absent" state is spelled
   `ref.null.extern` rather than the singleton.
2. **The bound carrier already has a slot for the answer** — `$__bound_fn`'s
   `thisArg` field (#3140, `getOrRegisterBoundFnType`). `emitBoundFnValueFromLocals`
   (`src/codegen/expressions/calls.ts:2096`) writes `ref.null.extern` when no
   `thisArg` was supplied, which is the *same* value `bind(null)` produces —
   that single line is where boundness is currently thrown away on the bind
   path.

So the likely shape of the fix is **"absent" ⇒ the `$undefined` singleton;
`null` ⇒ `ref.null.extern`**, rather than a new companion global. Verify that
before committing to a design — the sloppy-mode global-object substitution
(`src/codegen/helpers/sloppy-this-global.ts`) and every `ref.is_null`-on-
`__current_this` reader have to agree on the new spelling, and that reader set
is the real blast radius.

## Why it needs its own slice

- It is **not** `bind`-specific: 4 of the 12 are `.call`/`.apply`.
- Its blast radius is every `this` read in standalone, so it needs a
  base-vs-head sweep far wider than the clause set above — nothing like the
  contained, gated change #4196 slice 1 could get away with.
- It **collides** with in-flight work: W21 is editing
  `src/codegen/named-this-call.ts` + `src/codegen/helpers/sloppy-this-global.ts`
  for the separate top-level-`this`-as-receiver admission fix (measured
  FIXED 4 / BROKE 0 on `10.4.3-1-{70,75}{-s,gs}`). Land that first; this issue
  should start from a tree that already contains it.

## Acceptance

- The 12 files above go fail → pass on `--target standalone`.
- A strict callee observes `null`, `undefined`, and a real object receiver as
  three distinct values; a sloppy callee still substitutes the global object for
  the first two.
- Verify-first (RED on the base commit), committed vitest, and zero regressions
  in a sweep sized to the `this`-reader population — not to `10.4.3`.

## Adjacent, explicitly NOT in scope

The **IsCallable-TypeError** family W21 also handed over — 18 files
(`language/expressions/call/11.2.3-3_{1..8}.js`, `S11.2.3_A2`,
`S11.2.3_A3_T{1..5}`, `S11.2.3_A4_T{1..4}`) plus
`built-ins/Function/prototype/{call,apply}/S15.3.4.{4,3}_A1_T{1,2}.js` — is a
different mechanism (calling a non-callable must throw TypeError; standalone
returns `undefined`/`null`). Verified still failing on
`issue-4196-bind-construct`. It shares a root with #4196's own 1-file IsCallable
row (`built-ins/Function/prototype/bind/15.3.4.5-2-1.js`) and should be sized
and sliced together with it, separately from this issue.

## Handoff from the #4202 lane — three things NOT to re-derive

Contributed by the lane that owns `named-this-call.ts` (issue #4202), after it
withdrew its own "this needs a new signal" conclusion. Recorded here because
they were established by measurement and would otherwise have to be found again.

### 1. Two states suffice, not three — and that is not obvious

The reader must answer for `f.call(null)`, `f.call(undefined)`, and a bare
`f()`. That looks like three spellings. It is not: **"absent" and "explicit
`undefined`" are observationally identical** under §10.4.3 — strict binds
`undefined` for both, sloppy binds the global object for both.

So `$undefined` can carry **both**, and `ref.null.extern` can mean **only**
explicit-null. That collapse is what makes the re-spelling tractable. Without
noticing it, the natural conclusion is that a third sentinel is required, which
is where the previous lane stalled.

### 2. The reader becomes a THREE-way branch, not a flipped two-way

Today the arm in `src/codegen/expressions.ts` (the `fctx.readsCurrentThis`
block, ~line 1135) reads the global, tests `ref.is_null`, and routes null to
`emitUnboundThis`, which itself splits strict/sloppy per #4190.

After the re-spelling it needs:

| observed | binding |
| --- | --- |
| `$undefined` | `emitUnboundThis` as today (strict → `undefined`, sloppy → global) |
| `ref.null.extern` | strict keeps `null`; **sloppy still binds the global object** |
| anything else | the value |

**The sloppy row is the trap.** Sloppy `f.call(null)` must still be the global
object, so this is emphatically *not* "stop coercing null".

### 3. Availability gate — the host lane has no non-null `undefined`

`undefinedSingletonActive` is `ctx.standalone || ctx.nativeStrings`, so the
JS-host lane has no non-null `undefined` in the externref plane. The
re-spelling therefore **cannot be unconditional**, and the host lane keeps
today's answer unless something else is arranged.

These rows fail on **both** lanes, so that is a decision to take deliberately
rather than discover in CI.

### File ordering

#4202's diff touches `named-this-call.ts` (3 lines in `receiverIsAdmitted`) and
`sloppy-this-global.ts` (one appended predicate). Once it lands, this issue's
edit to `receiverIsAdmitted` is a clean one-line addition beside it — the
`factIsStaticallyNullish` refusal is exactly the line to relax, and #4202 did
not move it.
