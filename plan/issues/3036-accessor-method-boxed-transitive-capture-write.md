---
id: 3036
title: "object/class methods & accessors can't read/write a BOXED transitively-captured outer variable (emit garbage)"
status: ready
sprint: current
created: 2026-07-04
updated: 2026-07-04
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures, object-literal methods, class methods, accessors, iterators
goal: spec-completeness
owner: fable
related: [3035, 3023, 2664, 2029, 2669]
architect_spec: candidate
---

# #3036 — [FABLE-RESERVED] accessor/method write to a BOXED transitively-captured var emits garbage

Split from #3035. This is the **broad-impact** half; validate via full CI /
`merge_group`, never a scoped sweep ([[project_broad_impact_validate_full_ci]]).

## Symptom

An object-literal **method shorthand**, a **class method**, or a **class
get/set accessor** that reads or writes a variable captured **transitively**
from a grandparent scope — when that variable is BOXED (a sibling closure
mutates it, so it lives in a `struct (field $value (mut T))` ref-cell) —
emits garbage: reads yield the f64/ref default (0 / NaN / null), writes NULL
the box global. The fn-expr-property form (`m: function(){}`) is CORRECT (it
routes through `compileArrowAsClosure`, box-aware).

Verified repros (host lane, `setExports` wired):

```ts
// BUG (=0): transitive object-literal METHOD write
let c = 0;
const make = function () { return { bump() { c += 1; } }; };
const o = make(); o.bump(); o.bump();          // c === 0, want 2

// OK (=2): same via fn-expr property
const make2 = function () { return { bump: function(){ c += 1; } }; };

// BUG (=0): transitive CLASS method write
const make3 = function () { class K { bump() { c += 1; } } return new K(); };

// BUG (=NaN): transitive CLASS getter read of boxed var
const make4 = function () { class K { get v() { return c; } } return new K(); };
```

This is the dominant blocker for the #2664 `merge_group` regressions: the
`for-await-of` / `async-generator` `*ary-init-iter-close` test262 files use a
`return() {}` method shorthand whose `doneCallCount += 1` never reaches the
shared box, so the loop/gen body reads `doneCallCount === 0` (want 1).

## Root cause

`{ m() {} }` method shorthand → `emitObjectLiteralMethodFn` (`literals.ts:842`)
→ (non-standalone) `compileArrowAsCallback(..., { needsThis: true })` →
`promoteAccessorCapturesToGlobals` (`closures.ts:353`). Class methods/accessors
reach the same `promoteAccessorCapturesToGlobals` path. For a captured local
that is already BOXED in the enclosing `fctx` (`fctx.boxedCaptures.has(name)`,
`localType` = the ref-cell type), the promotion registers the **box** in
`capturedGlobals` (global named `__captured_<name>`, type = ref-cell) — but the
accessor/method body's identifier resolution never derefs it:

- `identifiers.ts` read path (~L676): `capturedGlobals.get(name)` →
  `global.get idx` and returns the ref-cell type as the value. No `struct.get`.
- `assignment.ts` write paths (many sites — simple `=`, compound `+=`,
  prefix/postfix `++`/`--`, ~L367/598/4446/5341/5401/5594/5931…): `global.set`
  the box global with the raw value / null. No `struct.get`+`struct.set` deref.

`capturedBoxGlobals` (the transitive-fn box-in-global alias, `closures.ts`
~L462; consulted in `closures.ts` materialization + `calls.ts:13965`) is NEVER
consulted by `identifiers.ts` / `assignment.ts`. So a boxed captured name in an
accessor/method body is unhandled → garbage.

## Fix approach (recommended)

Make the accessor/method body deref the box for BOXED captured globals:

1. In `promoteAccessorCapturesToGlobals`, when the captured local is boxed
   (`fctx.boxedCaptures.has(name)` / `localType` is a registered ref-cell),
   register the promoted global in `ctx.capturedBoxGlobals`
   `{ globalIdx, refCellTypeIdx }` (NOT plain `capturedGlobals`), and store the
   inner value type. (It already does this for the transitive-fn case; extend
   to the direct-boxed-local case.)
2. In `identifiers.ts` read resolution, add a `capturedBoxGlobals` branch
   BEFORE `capturedGlobals`: `global.get boxIdx; struct.get refCellTypeIdx 0`,
   return the inner value type.
3. In `assignment.ts`, add a `capturedBoxGlobals` branch to EACH write site
   (simple, compound, prefix/postfix, destructuring-assign): read =
   `global.get boxIdx; struct.get`; write = `global.get boxIdx; <value>;
   struct.set refCellTypeIdx 0`. Mirror the existing `boxedCaptures`
   (local-box) deref emitters so the two stay in lockstep.

Low-risk argument: a `capturedBoxGlobals`-body name currently ALWAYS
miscompiles (no working path relies on it), so adding correct deref is
garbage→correct; names NOT in `capturedBoxGlobals` are untouched. BUT the change
touches `promoteAccessorCapturesToGlobals` (shared by object-literal methods +
class methods + class accessors), so **full `merge_group` validation is
mandatory** — a subtly-wrong capture fix silently miscompiles closures/methods.

### Alternative (rejected as riskier)

Route method shorthand through `compileArrowAsClosure` (like standalone +
fn-expr-property) instead of `compileArrowAsCallback`. Rejected: changes the
host-callback ABI (`needsThis` / host-invocability via `_walkWasmIterator`) for
methods that use `this` — broad blast radius on host-callable methods.

## Acceptance

- All four repros above return their `want` value.
- The 13 `for-await-of` / `async-generator` `*ary-init-iter-close` method-
  shorthand test262 files pass GENUINELY (with #3035 bug #1 + #2664 stacked).
- Full `merge_group` green (no new regressions in class-method / accessor /
  object-literal / closure suites).

## Handoff

Stack on `issue-3035-async-cps-iterclose-version` (has #3035 bug #1 + #2664).
Re-claim with `--force` if resuming that branch. Once #3036 lands there, the
whole stack clears #2664's `merge_group` regressions and can merge, delivering
#2664's +68 (`.next`-callability) win + the genuine iterator-close cluster.
