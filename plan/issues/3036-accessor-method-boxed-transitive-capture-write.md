---
id: 3036
title: "object/class methods & accessors can't read/write a BOXED transitively-captured outer variable (emit garbage)"
status: done
sprint: current
created: 2026-07-04
updated: 2026-07-05
completed: 2026-07-05
assignee: ttraenkler/dev-3036
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

## Implementation (dev-3036, branch `issue-3036-accessor-method-boxed-capture`)

Implemented the recommended fix. **Key design decision: ADDITIVE, not a
move.** Rather than moving boxed names OUT of `ctx.capturedGlobals` into
`ctx.capturedBoxGlobals` (which would silently change every unmodified
consumer — closure materialization, the class-defer heuristic, var-init
re-sync, `isUnresolvableIdent`), the boxed name is registered in **both**:
the existing `capturedGlobals` entry is kept byte-identical, and the same
global is **additionally** recorded in `capturedBoxGlobals` **with the inner
`valType`**. The scalar read/write sites consult `capturedBoxGlobals` FIRST
and deref; every other site is untouched. This makes unmodified paths provably
regression-free (an unmodified site sees exactly the old map state) and lets
the fix be added incrementally.

The `capturedBoxGlobals` entry `valType` is present ONLY for direct boxed
captures (a var the body reads/writes itself). The pre-existing transitive-fn
box entries (used only by closure materialization in `calls.ts`) leave it
undefined; `getCapturedBoxGlobal` returns `undefined` for those, so the scalar
sites never deref a name they shouldn't.

Files changed:
- `context/types.ts` — added optional `valType` to the `capturedBoxGlobals`
  entry type, with a doc note on the direct-vs-transitive distinction.
- `closures.ts` (`promoteAccessorCapturesToGlobals`) — after the existing
  value-global promotion, if the promoted local is boxed
  (`fctx.boxedCaptures.has(name)`), additionally register the global in
  `capturedBoxGlobals` with `refCellTypeIdx` + `valType`.
- `property-access.ts` — three shared helpers: `getCapturedBoxGlobal`
  (resolve, valType-gated), `emitCapturedBoxGlobalRead` (null-guarded
  `global.get; struct.get 0`, mirrors the boxedCaptures local-box read),
  `emitCapturedBoxGlobalWrite` (null-guarded `struct.set 0` from a temp local).
- `identifiers.ts` — read branch before `capturedGlobals`.
- `assignment.ts` — box-first branches at: simple `=`, the
  destructuring/for-of write helper, the top of `compileCompoundAssignment`
  (covers `+=`/`-=`/… numeric + externref string-concat via the shared
  `emitCompoundOp`), and the logical-assign (`&&=`/`||=`/`??=`) storage
  descriptor (new `capturedBox` kind).
- `unary-updates.ts` — box branches at prefix `++`, prefix `--`, postfix
  (`emitCapturedBoxGlobalIncDec`, f64-based, prefix→new / postfix→old).
- `registry/imports.ts` (`fixupModuleGlobalIndices`) — shift each
  `capturedBoxGlobals` entry's `globalIdx` on a late string-constant import.
  **This was also a latent staleness bug for the existing transitive-fn box
  global** (its object-valued entries were never shifted); fixing it here
  covers both.

### Verification

- All #3036 read/write/increment repros (`.tmp/repro-3036.mts`) flip
  garbage→correct: transitive object-method write (=2), class-method write
  (=2), method-shorthand write, object-method `c++` (=2), class-method `--c`
  (=-2), boxed-capture getter read under **static** dispatch (=5), class-method
  read via `any` (=5), iterator-close `return(){}` (=1).
- **The 12 method-shorthand `for-await-of/*ary-init-iter-close*` test262 files:
  0/12 pass on the base (`3844b8a`, #3035+#2664 without #3036) → 12/12 pass on
  this branch.** My fix is exactly what flips them (genuine executions, not
  vacuous). (Spec estimated "13"; there are 12 with `return(){}` shorthand.)
- Full `tests/equivalence/` suite (1638 tests): **identical failure set** on
  this branch vs the base commit (15 files / 36 tests fail on BOTH; 1599 pass
  on both) — zero regressions. Targeted closure/accessor/class/method/capture
  files (`accessor-side-effects`, `getters-setters`, `classes`,
  `class-methods`, `flatmap-closure`, `#1712`, `#1528`, `#1573`, `#2623`
  capture-box-depth, `#2029` family) also identical to base. `tsc --noEmit`
  clean.

### Out of scope / caveat (separate pre-existing bug, NOT #3036)

The spec's 4th repro — a getter read via an **`any`-typed receiver on a class
declared inside a function** (`const o: any = make(); o.v`) — still returns
`NaN`. This is a **separate, orthogonal dynamic-accessor-dispatch bug**: a
getter returning a **constant** (no capture at all) also returns `NaN` through
that exact dispatch shape (`class K { get v(){ return 42; } }` inside a fn,
read via `any` → `NaN`). My additive branches are no-ops for non-boxed names,
so that codegen is byte-identical to before. The #3036 capture fix for getter
*reads* is proven correct by the static-dispatch case (→5) and the
class-method-read-via-any case (→5). The `any`-receiver nested-class accessor
dispatch gap should be filed as a follow-up; it is not the boxed-capture deref
mechanism #3036 targets, and per the senior-dev STOP-AND-DOCUMENT guard I did
not fold a second, unrelated dispatch redesign into this PR.
