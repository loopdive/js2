---
id: 4428
title: "`new Array(<wrapper>)` element loses object identity — x[0] comes back as the unwrapped primitive"
status: done
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
loc-budget-allow:
  - src/codegen/typeof-delete.ts
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-constructor
goal: standalone-gap
related: [4426, 2987, 3962]
origin: "2026-08-15 ES5-standalone session — residual of the #4426 §23.1.1.1 single-non-number-argument fix."
---

# #4428 — `new Array(<wrapper>)` element loses object identity

## Problem

After #4426, `new Array(x)` with a provably non-number single argument
builds the one-element array `[x]` (length 1 — correct). But when `x` is a
WRAPPER OBJECT, the stored element is the unwrapped primitive, so identity
asserts fail:

```js
var obj = new Boolean(false);
var x = new Array(obj);
x.length === 1;      // ✓ (fixed by #4426)
x[0] === obj;        // ✗ — x[0] is primitive false (test262 S15.4.2.2_A2.3_T2)
```

Same for `new String("0")` (S15.4.2.2_A2.3_T3: `x[0]` is `"0"`, SameValue
against the wrapper fails). `new Number(0)` (T4) PASSES — so Number
wrappers survive the same lane while Boolean/String wrappers don't.

test262 (ES5 standalone): S15.4.2.2_A2.3_T2, S15.4.2.2_A2.3_T3.

## Implementation Plan

1. Establish WHERE identity is lost — three candidates, probe each:
   a. `new Boolean(false)` / `new String("0")` construction: do these even
      produce a distinct object in standalone, or do they lower to the
      primitive/box directly? Probe `var a = new Boolean(false);
      var b = new Boolean(false); a === b` (must be false — distinct
      objects) and `typeof a` (must be "object"). If construction itself is
      primitive-collapsing, THAT is the bug and the Array test is
      collateral — re-scope to the wrapper constructors
      (`expressions/new-indexed.ts` / `standalone-subclass-ctors.ts`,
      compare with the working `new Number` lane, and check
      `standalone-wrapper-instanceof.ts` (#4276 follow-up) for the current
      wrapper representation contract).
   b. The #4426 one-element path (`new-indexed.ts` `args.length === 1`
      non-number branch): `compileExpression(arg, { kind: "externref" })` —
      does the externref coercion unwrap? Compare the WAT for the `new
      Number` (passing) vs `new Boolean` (failing) arg.
   c. The read side: `x[0]` on an externref vec through the dynamic lane —
      does `__extern_get_idx`/unbox demote a stored wrapper to primitive?
2. Fix at the narrowest failing layer; do NOT introduce a new wrapper
   representation (that is #4276-adjacent substrate — coordinate via the
   issue files if the fix would collide with
   `src/codegen/standalone-wrapper-instanceof.ts`).
3. Verify with the single-test driver
   (`runTest262File(path, cat, 15000, "standalone")`):
   S15.4.2.2_A2.3_T2/T3 flip; T1/T4/T5 stay green; scoped filter
   `built-ins/Array/length` shows no regression.

## Acceptance criteria

- S15.4.2.2_A2.3_T2 and _T3 pass standalone; _T1/_T4/_T5 remain passing.
- `a === b` for two `new Boolean(false)` is `false`, `typeof` is
  `"object"` — or, if wrapper-construction identity is deliberately out of
  scope, the issue documents the layer where identity is lost and files the
  residual against the wrapper-constructor issue.

## Localization — all three suspects are INNOCENT

Step 1's three candidates were probed individually (`.tmp/p1.mjs`,
standalone + `hostBridge: always`, module-init driven). Every one is fine:

| Probe                                              | Result |
| -------------------------------------------------- | ------ |
| `new Boolean(false) === new Boolean(false)`        | false — distinct objects |
| `typeof new Boolean(false)`, `new String("0")`     | `"object"` |
| `new Boolean(false) === false` / `new String("0") === "0"` | false — no primitive collapse |
| (a) construction                                    | OK for Boolean, String **and** Number |
| (b) #4426 one-element path, in isolation<br>`var o = new Boolean(false); var x = new Array(o); x[0] === o` | **true** — identity preserved |
| (c) read side (`x[0]`, `typeof x[0]`) off an externref vec | OK |

So neither the wrapper constructors nor #4426's `compileExpression(arg,
{kind:"externref"})` lose anything, and the `new Number` lane is not special.

## The layer identity is actually lost at — the SLOT, not the array

The failing tests write the same `var` **twice**:

```js
var x = new Array(true);      // checker: boolean[]  → (mut $__vec_i32)
var obj = new Boolean(false);
var x = new Array(obj);       // builds a $__vec_externref …
```

TypeScript keeps declaration #1's type for a redeclared `var` in a `.js`
source (verified directly against the checker: both declarations report
`boolean[]`, and `x[0]` reports `boolean` — no union). `moduleGlobalWasmType`
pins the global from that type, so the second store is a **vec→vec coercion**
(`emitSafeStructConversion` → `emitVecToVecBody`, type-coercion.ts) that copies
element-by-element through `ToNumber` + `i32.trunc_sat_f64_s` — visible in the
emitted WAT of the T2 shape. The Boolean wrapper arrives as i32 `0`.

That also explains the T4/T5-pass / T2/T3-fail split exactly: T4 and T5 have
**no primitive-array predecessor** to pin the slot, so their arrays stay
externref-element vecs. It is not a Number-vs-Boolean/String difference at all
— `var x = new Array(1); var x = new Array(new Number(0))` passes, and
`var x = [true]; var x = [obj]` (plain array literals, no `Array` constructor
involved) fails identically. The bug has nothing to do with `new Array`.

## Fix

New module `src/codegen/declarations/array-rebind-element-widening.ts`, hooked
into `moduleGlobalWasmType` (declarations.ts). When a module-scoped binding is
written with BOTH an object-element array and a primitive-element array, the
slot keeps its vec type and its **element** type widens to `externref`.

Widening the CARRIER instead (the #4204 / `bindingHasMixedAssignmentCarrier`
answer, plain `externref`) was measured and rejected: it preserves `x[0]`'s
identity but breaks `x.length` (reads `0`), trading one failing assertion in
these very tests for another.

The predicate is deliberately narrow — it needs two SEPARATE writes with
disagreeing domains, every element tag non-`mixed`, and each write
syntactically classifiable (array literal, or `Array(...)`/`new Array(...)` in
its element form, with the §23.1.1.1 single-Number-argument LENGTH form
excluded). One unclassifiable write to a binding abandons the analysis for that
binding. Mixing within a single write (`[obj, true]`) is left to the
array-literal element-typing lane.

Companion soundness guard in `typeof-delete.ts`: a widened binding keeps its
first declaration's checker type, so `typeof x[0]` const-folded to `"boolean"`
without reading the value. Both fold sites now take the runtime path for an
element read off a widened binding — the exact analogue of #4204's
`moduleGlobalIsDynamicButStaticallyPrimitive`. Folds that LOWER from the
checker type (`===`, `.length`, the indexed read itself) were verified sound.

## Test Results

test262 standalone, `built-ins/Array/length` (30 files, runner-verified
before AND after on this branch):

| | before | after |
| --- | --- | --- |
| bucket | 19 pass / 11 fail | **21 pass / 9 fail** |
| S15.4.2.2_A2.3_T2 | fail (`x[0]` is primitive `false`) | **pass** |
| S15.4.2.2_A2.3_T3 | fail (`x[0]` is primitive `"0"`) | **pass** |
| _T1 / _T4 / _T5 | pass | pass |

The other 9 failures are unchanged and unrelated (length-overflow, `toString`
tag, defineProperty coercion order, a missing quickjs provider).

`language/statements/variable` is 55 pass / 26 fail on BOTH sides — the
widening changes nothing there.

`npm test -- tests/es5-standalone-wrapper-exotics-replace.test.ts
tests/es5-standalone-ctor-identity.test.ts` — 19/19 green before and after.

Equivalence: the 14 array/object-shaped files under `tests/equivalence/`
(92 tests) are 91 pass / 1 fail, and that one failure —
`array-inline-return.test.ts > find does not hijack return`, a checker
diagnostic `Type 'number | undefined' is not assignable to type 'number'` —
reproduces identically with both hooks reverted. Pre-existing, not chased.
(The full 214-file `tests/equivalence` run OOMs in this container with other
agents' suites running concurrently, per CLAUDE.md's note; CI runs it.)
New pin: `tests/issue-4428.test.ts`, 12 tests, including a
`homogeneous-array-is-NOT-widened` case that guards the predicate's narrowness
and a `.length === 1` case that rules out the carrier widening.

## Residuals (not fixed here)

1. **Function-local bindings take the same loss.** The hook is on
   `moduleGlobalWasmType` only; the local-slot minting sites
   (`localTypeForDeclaration` in statements/variables.ts and the var-hoist path
   in index.ts) still pin the vec from declaration #1. `function f() { var x =
   [true]; var obj = new Boolean(false); x = [obj]; return x[0] === obj; }`
   remains false. Not reachable from the target tests (test262 top-level code
   is module-scoped), and the local sites carry extra constraints — a slot
   retype has to agree with closure-capture ABI (#3123) and the hoist-time seed
   (#3316) — so it wants its own slice rather than a drive-by.
2. **Disagreement between two OBJECT element types is out of the predicate's
   scope** — it fires only on object-vs-primitive, the identity-destroying case
   these tests exercise. Probed and NOT currently broken:
   `var x = [new Boolean(false)]; var obj = new String("0"); var x = [obj];
   x[0] === obj` is already true without the widening. Left alone rather than
   widened speculatively.
3. **`x.length` on a boxed-externref array carrier reads `0`** — measured while
   evaluating the rejected carrier widening (`var x = 1; x = new Array(obj);
   x.length`). Pre-existing, independent of this issue, and the reason the fix
   widens the element type instead.
