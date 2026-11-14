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

## Review round 1 (PR #7231, 2026-11-13) — findings and fixes

Fixed by the senior developer who took over the branch. Measured on the
branch merged with main `5b1f4794bb`, standalone, one process at a time.

**B1 (wrong answer): fixed.** `Object.getOwnPropertyDescriptor(Function,
"prototype")` yields `%Function.prototype%`, and that object's own
`constructor` is `%Function%`.

The rule is now stated over what the result can hold. A mention is inert
when no value it yields is `%Function%` or `%Function.prototype%`. An
ordinary function value is allowed, because its inherited `constructor`
reaches `%Function%` the way every function in the program does.

The descriptor pairs that qualify, each pinned in
`tests/issue-7343-function-inert-uses.test.ts`:

| receiver | inert keys | why |
| --- | --- | --- |
| `Function` | every key except `"prototype"` and `"constructor"` | `length` and `name` hold a number and a string; any other key has no own descriptor |
| `Function.prototype` | every key except `"constructor"` | `call` / `apply` / `bind` / `toString` and the `caller` / `arguments` thrower are ordinary functions; the rest are a number or a string |

Both reviewer repros are "stays a site" rows. A source write cannot put
either intrinsic under another key without a `Function` mention that is
itself a site, so the descriptor rule needs no key-write screen.

**S1 (writes ignored): fixed.** `Object` must be unpatched as well as
undeclared: no literal-route write of `Object` or of the static being
called. The screen reuses `sourceWritesMemberNamed`
(`shared/intrinsic-prototype-writes.ts`) and adds no third mechanism. It
covers:
- `Object = …`;
- `Object.isSealed = f`;
- `globalThis.Object.isSealed = f`;
- an alias's `O["isFrozen"] = f`;
- `Object.defineProperty(Object, "isSealed", …)`;
- `delete`.

It also refuses any `with` statement, through a new `hasWithStatement`
that shares `hasDynamicScope`'s single cached walk in
`shared/binding-writes.ts`.

Two coarser screens were measured and rejected, because test262's own
`$262` prelude stores `globalThis` and `globalThis.Object`:
- `sourceMayPatchPrototype(…, "Object")` and `sourceMayWriteGlobalObject`
  are true in every assembled test, so the yield dropped from 9 to 0;
- `hasDynamicScope` is true in every test, because of the
  `$262.evalScript` shim's `eval`, and `sourceNamesReflectiveRoute` fires on
  `getPrototypeOf` itself.

What the screen does not catch:
- A write under a computed name is outside the boundary, as it is for the
  object statics (`objectStaticsArePristine`, #3776).
- A direct `eval` could patch either intrinsic, but it is a site of its own
  in both readers.

**S2: dropped `isBareFunctionPrototypeValue`.** The bare
`Function.prototype` value is now a site in both readers.
- On the 249-file population, routing with the excusal and without it is
  identical, file for file (`PROBE_KEEP_BARE` A/B).
- The reviewer's `s03` (`var P = Function.prototype;
  P.constructor("return 7;")`) now passes. It fails on main.

**S3: done.** The flag parameter is gone. There are two flat entry arms,
`isInertFunctionUse` and `isInertPrototypeUse`, over the shared
`isInspected` / `describesKey` / `objectStaticCalledOn`.

### Re-measured (main `5b1f4794bb`)

| | files |
| --- | --- |
| gained (IR-only now) | 9 (the same 9 as before the review) |
| lost | 0 |
| units newly legacy | 0 (legacy units 995 → 756; it was 751 before the review: B1 and S2 keep 5 more units legacy) |
| new compile errors | 0 |
| post-claim errors | 1 → 1 (the same file) |
| routing changed | 41 (42 before the review) |

- **Verdicts:** the 41 routing-changed files pass on both trees,
  standalone, with the interpreter eval provider built per tree
  (`JS2WASM_EVAL_ENGINE=interpreter TEST262_FULL_RUNTIME_EVAL=1`).
- **The reviewer's 29 probes:**
  - main passes 17, the branch 18;
  - no probe passes on main and fails on the branch;
  - the one flip is `s03`, from fail to pass;
  - the 11 still failing fail on main too: r02/r03/r04, r10–r14, r17,
    r22, s02.
- **gc (JS environment):** byte-identical on the 200-file sample without a
  `Function` mention.

## Review round 2 (PR #7231, 2026-11-14): MET

Round 2 found no program that passes on main and fails on head; `s03` and
`t18` newly pass. Two should-fix items were left, plus a nit.

**S1: the comment "a source write cannot put either intrinsic under another
key without a site" was false. Disposition: the doc now states the real
limit, pinned by a test (option D).**

Two writes put `%Function%` under a new key with no site:
- `Function.prototype.k = (function () {}).constructor`, because the member
  arm treats a write target like a read;
- `Object.defineProperty(Function.prototype, "k", { value: (function ()
  {}).constructor })`, a discarded define with a literal key.

A later inert read then hands that value out. Main has the same exposure
through its `Function.prototype.<member>` excusal. It is harmless only
because a function value's inherited `.constructor` cannot evaluate source
in this compiler today.

Tests in `tests/issue-7343-function-inert-uses.test.ts` pin that dependency
so it cannot rot silently:
- the `FN_CONSTRUCTOR_EVALUATES` rows: `(function () {}).constructor("return
  7;")()` throws on standalone and on the default target, and no
  `js2wasm:runtime-eval` import is linked;
- the `INERT_TODAY_KNOWN_LIMIT` rows (both counterexamples, plus a store
  followed by a descriptor read) state today's inert answer.

Stores and `defineProperty` statements stay inert, exactly as on main.

The two sound variants were measured (249-file population, against main
`9745e46d72`) and rejected. Both send back to the legacy compiler units that
main lowers on IR, which is not allowed:

| variant | rule | gained | units newly legacy |
| --- | --- | --- | --- |
| A | every store into `Function.prototype.<k>`, and every define with a non-literal descriptor, is a site | 9 | **85 units in 17 files** (`Function.prototype.myproperty = 1`, `.property = 12`, `.get = function…`, `.toString = Object.prototype.toString`, …: main excuses them all) |
| B | a store is inert, but a READ of key k is a site when the file writes any member named k (`sourceWritesMemberNamed`) | **8** | **68 units in 12 files** |

Variant B's losses come from the key screen not knowing the receiver. sta.js
writes `Test262Error.prototype.toString`, which makes every
`Function.prototype.toString` read a site:
- the gained `getOwnPropertyDescriptor/15.2.3.3-4-35`;
- the `Function/prototype/toString/S15.3.4.2_A*` family;
- `bind/15.3.4.5-2-2` (`f.bind = …`).

The Variant B patch is kept in the review scratch (`round2-readside.patch`).

**S2: done.** Test rows pin the `Object` write screen's limit (the #3776
boundary):
- `Object["is" + "Sealed"] = f` stays inert (not seen);
- `var O = Object; O.isSealed = f` is a site (seen).

**Nit: done.** `hasWithStatement`'s doc notes that
`sourceNamesReflectiveRoute` also counts `with` as a reflective route.

## Follow-ups

- **Make stores into `Function` / `Function.prototype` sound without losing
  units (option C).**
  - Make the written-key screen receiver-aware: per-intrinsic written-key
    sets in `src/shared/intrinsic-prototype-writes.ts`, which already tracks
    `writes` per patchable intrinsic through `prototypeOwner`.
  - Treat a fresh stored value as harmless: a primitive literal, a function
    or arrow expression, an object or array literal.
  - With both, a read of `<k>` is a site only when the file stores a
    non-fresh value under `<k>` on `Function` / `Function.prototype`.
  - Not measured. It would avoid both A's and B's losses on this population.
  - **Required before** a function value's inherited `.constructor` can
    evaluate source (the `FN_CONSTRUCTOR_EVALUATES` rows flip).
