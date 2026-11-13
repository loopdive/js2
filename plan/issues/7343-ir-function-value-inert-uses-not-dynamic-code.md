---
id: 7343
title: "IR: a `Function` value in an inert position is not dynamic code"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-11-13
updated: 2026-11-13
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7342, 7338, 3630, 4633]
---

# #7343 — IR: a `Function` value in an inert position is not dynamic code

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only").

A file that only _mentions_ `Function` as a value, for example
`Object.isSealed(Function)` or `x instanceof Function`, is treated as if it
could run dynamic code. Two things then happen, both after selection, so no
selector change can reach them:

1. `src/deadcode-elide.ts:340` records an "unknown dynamic code position" and
   keeps the otherwise unused `$262.evalScript` shim alive.
2. With the shim alive the module is in runtime-eval carrier mode, and
   `withdrawEvalBoundaryFunctions`
   (`src/codegen/ir-overlay-preparation.ts:74`) withdraws every harness
   function as `eval-visible-binding` / `boundary-closure`.

The file loses all its IR units although nothing in it can evaluate code.

## Measured (2026-11-13, main `fac67fe855`, standalone)

Source: `plan/log/ir-behind-the-selector-2026-11-13.md` and its follow-up
research (600-file sample of the 7,086 blocked ES5 files).

- 8 of the 600 sampled files carry this cause, and in all 8 it is the only
  cause that puts the file behind the boundary. Scaled to the blocked
  population that is on the order of 90 files; the real number is the first
  thing S1 measures.
- A local trial of the narrowing below on those 8 files: 7 stop crossing the
  boundary, 2 become IR-only, 4 are left with `<module-init>` as their only
  legacy unit, and 1 (`Function.call(this, src)`, real dynamic code) correctly
  stays. Legacy units per file went from 6, 6, 6, 6, 21, 6, 6, 6 to
  0, 0, 6, 1, 8, 1, 1, 1.
- All 7 files whose routing changed pass under
  `scripts/run-test262-paths.mts --standalone` without an eval provider.

Forms seen:

| form | inert |
| --- | --- |
| `x instanceof Function` | yes |
| `Object.isSealed(Function)`, `isFrozen`, `isExtensible` | yes |
| `Object.getPrototypeOf(Function.prototype)` | yes |
| `Object.getOwnPropertyDescriptor(Function, "prototype")` and `(Function.prototype, "call")` | yes, literal key other than `"constructor"` |
| `Object.defineProperty(Function.prototype, "prop", …)` as a statement | yes, same key rule |
| `Function.call(this, "return …")` | no, real dynamic code |

## Implementation Plan

### Target structure

- **One predicate, one module.** Today the question "can this `Function`
  mention run code" is answered twice, by a documented mirrored pair:
  `isFunctionPrototypeMethodReceiver` (`src/deadcode-elide.ts:84`) and
  `isFunctionPrototypeMethodChain`
  (`src/ir/runtime-eval-boundary-plan.ts:293`). This issue does not add a
  third copy and does not widen both by hand. It moves the shared answer into
  one function in `src/shared/` (next to `ambient-intrinsics.ts`, which both
  layers may import) and makes both call sites use it. The two existing
  functions are deleted or reduced to that call.
- **What it reuses.** The existing "prototype method chain" excuse becomes one
  arm of the shared predicate; the inert positions below are further arms of
  the same function. `isNonReferenceEvalMention` stays where it is: it is
  about `eval`, not `Function`.
- **What duplicate it removes.** The mirrored pair and its "keep the two in
  sync" comments.

### The rule

A read of the identifier `Function` (resolving to the ambient global, not a
shadowing binding), or of `Function.prototype`, is **inert** when its value
flows only into one of:

- the right operand of `instanceof`;
- an operand of `==`, `!=`, `===`, `!==`;
- the operand of `typeof`;
- the first argument of `Object.isSealed`, `Object.isFrozen`,
  `Object.isExtensible`;
- for `Function.prototype` only: the argument of `Object.getPrototypeOf`
  (the answer is `%Object.prototype%`);
- the first argument of `Object.getOwnPropertyDescriptor`, or of
  `Object.defineProperty` used as an expression statement, when the key
  argument is a string literal other than `"constructor"`.

`Object` in those calls must be the ambient global. Every other position
stays a dynamic-code site, in particular anything from which `.constructor`
or the function itself can be read back (a returned descriptor of
`"constructor"`, a stored value, an argument to a user function, a call or
`new`).

### Slices

- **S1 — the fold and the rule.** Move the predicate, add the inert arms,
  route both call sites through it. One PR.
- **S2 — only if S1's census shows it pays:** fold the harness
  `fnGlobalObject.js` form `Function("return this;")()` (literal source, 3
  sole-blocker files in the sample). Not planned in detail here.

Out of scope: files with real `eval` / `Function(…)` in the test body (55
sole-blocker files in the sample). That is the runtime-eval ownership topic
(#3630). Also out of scope: the caller-activation gate, which is the only
blocker in no sampled file.

### Constraints

- Standalone only; no new host imports.
- JS-environment output byte-identical. The shim is dropped by dead-code
  elimination, so check the gc target explicitly on files that mention
  `Function` in an inert position.
- Refuse-at-select is not affected: the boundary withdraws after selection
  today and keeps doing so; this issue only makes it fire less often.
- No unit that main lowers on IR may be lost.

## Acceptance criteria

Correctness:

1. Census on all blocked ES5 files that mention `Function` outside a call or
   `new` (population listed in the PR): files gained IR-only > 0, files lost
   0, units lost 0, new compile errors 0, post-claim errors not increased.
2. Every file whose routing changes has the same verdict as on main under
   `scripts/run-test262-paths.mts --standalone` with the eval provider
   available (CI baseline), and passes without the provider.
3. Files with real dynamic code keep their boundary: `Function.call(this,
   src)`, `Function.apply`, `Function.prototype.constructor`, a stored
   `var F = Function`, `Object.getOwnPropertyDescriptor(Function.prototype,
   "constructor")`, and a shadowed `Object` or `Function` each get a test row
   showing the site is still recorded.
4. gc output byte-identical on the changed-routing files and on a sample of
   files without any `Function` mention.

Code quality:

5. Exactly one function answers "is this `Function` mention inert"; the
   mirrored pair is gone, and no "keep in sync" comment remains.
6. The predicate is a flat list of position arms, without flag parameters;
   `deadcode-elide.ts` and `runtime-eval-boundary-plan.ts` do not grow.
7. A fresh-context adversarial review records its verdict in the PR body.

## S1 result (2026-11-13)

Built as planned, with the differences below. Measured with the branch
merged with main `34e285a3f4` (after #7338) and that tree as the base,
standalone, original harness, one process at a time. The numbers are the
same as against the branch base `e2eae68fc5`.

Population: the 249 ES5 files of `es5-map-1111` that are not IR-only and
whose test body mentions `Function` outside a call or `new`.

| | files |
| --- | --- |
| gained (IR-only now) | 9 |
| lost | 0 |
| units newly legacy | 0 (legacy units 995 → 751) |
| new compile errors | 0 |
| post-claim errors | 1 → 1 (the same file) |
| routing changed | 42 |

Gained: `Object/getOwnPropertyDescriptor/15.2.3.3-4-35`, `-36`, `-37`, `-38`;
`Object/isExtensible/15.2.3.13-2-14`; `Object/isFrozen/15.2.3.12-3-4`, `-5`;
`Object/isSealed/15.2.3.11-4-4`, `-5`.

Verdicts of the 42 routing-changed files: all pass on this branch under
`scripts/run-test262-paths.mts --standalone` with no eval provider, and on
the default (JS environment) target. All 42 pass in the CI standalone
baseline. Locally, main fails all 42 only because the QuickJS provider is
not built here.

### Differences from the plan

1. **An equality operand is NOT inert.** An equality compares identities,
   and only a provider-linked module keeps ONE `%Function%` (#4442).
   Measured with the arm in: `var f = function () {}; f.constructor ===
   Function` answered `false` on standalone once the module was
   provider-free. #4442's "keeps a bare `Function` read on the provider
   route" test caught it. The arm is dropped, and the equality form is a
   must-stay-a-site test row.
2. **JS-environment (gc) output is NOT byte-identical on the 42
   routing-changed files** (it is on the 200-file sample without a
   `Function` mention). Dead-binding elision runs for the JS environment's
   native regime as well (`compiler.ts`, `targetProfile.nativeRegime`), and
   the boundary plan serves both targets. So the dropped shim and the
   missing `intrinsic-value` site change gc output exactly as they change
   standalone. All 42 pass on the gc target without a provider. Keeping gc
   identical would need a target-dependent answer from the one predicate,
   which the plan rules out (no flag parameters). This needs a decision
   (criterion 4).
3. **The runtime-eval boundary plan keeps its own bare-`Function.prototype`
   excusal** (`isBareFunctionPrototypeValue`). Elision never shared it:
   computed source could reach the prototype's constructor there. So
   `Object.getOwnPropertyDescriptor(Function.prototype, "constructor")`,
   `Object.defineProperty(Function.prototype, …)` used as a value, and a
   computed key stay elision sites. In the boundary plan they are not sites,
   exactly as on main.
4. **Elision gains the boundary plan's wrapper and destructure handling** of
   the method chain (`(Function.prototype).call`,
   `const { call } = Function.prototype`), which it lacked. This is the same
   sound argument, now in one place.
5. **Shadowing is syntactic**: `Function` and `Object` are the ambient
   globals when nothing in the file declares either name
   (`isUndeclaredInFile`, `shared/ambient-intrinsics.ts`). Elision runs
   before any checker exists. The method-chain arm keeps main's behaviour
   (no shadowing test).

S2 (the `Function("return this;")()` fold) is not built; whether it pays is
open (3 sole-blocker files in the 600-file sample). The issue stays
in-progress for it.
