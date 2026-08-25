---
id: 4484
title: "ES5 standalone: operator/coercion smalls — instanceof [[HasInstance]], null/undefined member ToObject throws, strict-assignment throws, `in` on plain maps (~30 rows)"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-15
updated: 2026-08-18
loc-budget-allow:
  # The substance of this change is in two NEW modules
  # (nullish-receiver-coercible.ts, builtin-nonwritable-write.ts). What lands in
  # the god-files is only the dispatch hook that reaches them — 10-44 lines
  # each, mostly the comment explaining the spec ordering the hook enforces.
  # Each hook must sit at a specific point in an existing decision chain (ahead
  # of the builtin-method interception, ahead of the primitive-LHS fold), so it
  # cannot be moved out of the driver without inverting that chain.
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions.ts
func-budget-allow:
  # Same reason, at function granularity. `compileHostInstanceOf` crosses the
  # 300-LOC threshold by +5 for the namespace-RHS arm; the other four grow by
  # 9-15 lines of guarded early-return plus its rationale comment.
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/expressions/identifiers.ts::compileHostInstanceOf
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: operators
goal: standalone-gap
related: [4426, 4434, 4464]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. instanceof (7) + property-accessors (6) + assignment strict-throws (4-10) + types/object (12) share operator-level root causes."
---

# #4484 — ES5 operator/coercion smalls

## Problem

Four small operator-level families, ~30 rows total:

- **A — instanceof (7)**: `({}) instanceof Object` false or throwing;
  non-callable RHS must throw TypeError ("Right-hand side ... is not an
  object" leaks host error text); `[[HasInstance]]` for builtin
  constructors.
- **B — member access on null/undefined (6)**: `undefined.toString()` /
  `null.toString()` must throw TypeError (§9.10 CheckObjectCoercible);
  today: wrong class or no throw. Two `Builtin.constructor` codegen-error
  rows (`Object.constructor`, `Boolean.constructor` static-prop CE) ride
  along — decline to the #3006 carrier read instead of CE.
- **C — strict assignment throws (4)**: assignment to non-writable /
  undeclared in strict code must throw TypeError/ReferenceError.
- **D — types/object misc (12)**: `"foo" in map` on object literals,
  prototype-of-non-extensible mutation, this-binding rows. Triage first;
  fix what is bounded, hand descriptor-dependent rows to #4479.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   per-family file lists first.
2. A: find the instanceof lowering (grep `instanceof` in
   `src/codegen/expressions/`); `({}) instanceof Object` needs the builtin
   constructors' [[HasInstance]] against the #3006/#4442 carriers; real
   TypeError instances via `buildThrowJsErrorInstrs`. #2916's
   `native-dynamic-instanceof.ts` is the existing dynamic arm — extend it,
   don't fork it.
3. B: the CheckObjectCoercible throw belongs at member-access lowering on a
   statically-null/undefined or runtime-nullish receiver — the
   `finalizeStructAndDynamicMemberGet` null path is the hook; the CE rows
   are a decline-not-error fix at the static-receiver band (#4460's new
   band is adjacent — read it first).
4. C: strict-mode write sites — find where assignments to consts/globals
   lower; scope to the 4 measured rows, don't build a general strict-mode
   engine here.
5. D: triage, fix bounded rows (`in` operator on literal-backed $Objects
   likely shares the #4062 named-key presence work — read
   `vec-named-key-presence.ts`).
6. Controls: scoped sweeps per directory; operator equivalence per-file
   subset; fn-family pins untouched.

## Acceptance criteria

- ≥15 rows flip across the four families; zero regressions; residuals
  routed (#4479 for descriptor-dependent, #4480 for prototype-dependent).

**Not met: 9 of 15.** Zero regressions and the residuals are routed, but the
row count falls short. See `## Why the row count fell short` — it is a
scope finding, not an unfinished slice.

## Root cause

Four independent defects, one per family.

**A — `instanceof`, three separate mistakes.**

1. *Ordering.* §7.3.20 OrdinaryHasInstance checks `IsCallable(C)` at step 1 and
   `Type(V) is Object` only at step 3, but `emitDynamicInstanceOf` ran the
   #2998 primitive-LHS fold FIRST. `1 instanceof Math` therefore answered
   `false` instead of throwing.
2. *Namespace RHS.* `Math`/`JSON`/`Reflect`/`Atomics` are ordinary objects with
   no [[Call]], but the oracle classifies them as `builtin`, which
   `isProvablyNonCallableObjectType` deliberately declines (that band exists to
   protect `Function`, a callable with no signature of its own). The name also
   resolved into the builtin dispatch, which folded it to `false` before the
   non-callable arm was reachable at all.
3. *Stale static type on a reassigned binding.* `var OBJECT = 0; OBJECT = Object`
   leaves the DECLARED type `number` — the write is a type error that
   `skipSemanticDiagnostics` suppresses, so TS never narrows back. The step-1
   fold read that as proof of a primitive RHS and threw "Right-hand side of
   'instanceof' is not an object" for an RHS holding the real constructor. A
   wrong throw is catchable, so this was observable, not merely imprecise.

**B — member access on a nullish receiver.** §13.3.2.1 evaluates
`MemberExpression . IdentifierName` to a Reference whose `GetValue` runs
RequireObjectCoercible (§7.3.2) and throws TypeError for `null`/`undefined`.
The builtin-METHOD dispatch intercepted `undefined.toString()` far upstream on
the method NAME and never asked whether the receiver could carry a method at
all, so four of the six forms returned without throwing. Separately,
`Object.constructor` / `Boolean.constructor` refused LOUD
(`compile_error`) at the standalone builtin-static band, failing the whole
module over a read the spec answers uniformly: a builtin constructor inherits
`constructor` from `Function.prototype`, i.e. `%Function%`.

**C — strict write to a builtin's non-writable own property.** The #3872 arm
(`tryEmitNonWritablePropertyWrite`) reads `ctx.nonWritableExternKeys`, a mirror
of what the PROGRAM declared via `Object.defineProperty`. Properties the SPEC
fixes as `[[Writable]]: false` — `Math.PI`, `<Ctor>.length/name/prototype`,
`Number.MAX_VALUE` — were never in that mirror, so `Math.PI = 20` in strict
code silently did nothing instead of throwing (§10.1.9.2 step 2.b). Sloppy mode
was already correct and is untouched.

**D — `in` on a reassigned binding.** The same stale-static-type defect as A3,
reached through `inRhsIsExclusivelyPrimitive`.

## Fix

Two new modules carry the substance; the god-files get only the dispatch hook.

- `src/codegen/nullish-receiver-coercible.ts` (new) — §7.3.2 at the member
  READ and member CALL choke points, ahead of the builtin-method interception.
  The proof is **syntactic** (the `null` literal, the unshadowed global
  `undefined`, `void <literal>`), never the static type: TS reports `undefined`
  as the flow type of the ordinary test262 idiom
  `var probe; function f(){ probe = {}; } f(); probe.x`, so a type-based guard
  would throw wrongly there. Optional chains are excluded (they short-circuit).
  Arguments are deliberately not compiled — `GetValue` on the callee Reference
  throws before the argument list is evaluated (§13.3.6.1).
- `src/codegen/builtin-nonwritable-write.ts` (new) — the spec table for C, plus
  the unshadowed-global-receiver proof. `length`/`name`/`prototype` are admitted
  only for names in `BUILTIN_CTOR_ARITY`, the same table the carrier machinery
  uses to decide a name IS a constructor, so the two cannot disagree.
  Builtin METHODS are `[[Writable]]: true` and are absent by design.
- `native-ordinary-instanceof.ts` — the namespace set, and the
  `@@hasInstance` gate described below.
- `identifiers.ts` / `binary-ops-in.ts` — the reassigned-binding guards; a write
  to the name anywhere in the file disqualifies the static claim and routes to
  the runtime path, which decides from the VALUE.

### The @@hasInstance gate (found while re-verifying, not in the snapshot)

Reordering the step-1 arm ahead of the primitive-LHS fold (A1) widened an
existing over-throw. §13.10.2 consults `GetMethod(C, @@hasInstance)` at step 2
and CALLS it at step 4; the `IsCallable` throw is only step 5. So "the RHS is a
non-callable object" does not license a throw on its own —
`var F = {}; F[Symbol.hasInstance] = function () {…}; 0 instanceof F` must call
the handler.

Measured: `symbol-hasinstance-to-boolean.js` went from a wrong VALUE on base to
a wrong THROW with the snapshot applied. **Both spellings fail the test, so the
pass/fail sweep could not see it** — the row is fail→fail either way. It was
caught only by diffing the error text of unflipped rows. A wrong throw is
catchable and therefore observable; per the campaign's absent-not-wrong rule
the arm must decline instead.

`moduleInstallsCallableHasInstance` declines the arm for any module that
installs a possibly-callable `@@hasInstance`. The scope is the whole module
because the handler is installed by MUTATION on an arbitrary value, which no
static type of the RHS records — there is no expression-local fact to consult.
A `null`/`undefined` handler value still throws, because `GetMethod` maps those
to `undefined` and step 5's TypeError is then exactly right; that is
`symbol-hasinstance-not-callable.js`, which this issue flips to pass. Excluding
it would have given the row back for no correctness gain.

## Test Results

All numbers below are from runs I executed on this branch, A/B via
`.tmp/ab.sh` (base = `HEAD^1`, i.e. this branch without the #4484 diff).
604 files swept per side, standalone lane.

**Environment correction — the first base sweep was invalid.** The worktree had
no `.test262-cache`, so 21 rows across these directories failed with
"quickjs provider is not built" on BOTH sides and were invisible to the diff.
After copying the prebuilt artifact + adapters in, base pass over the four core
directories went 58 → 75 of 119. Every number here is from the re-run with the
provider live; the pre-provider sweep is discarded, not reported.

| directory                              | files | base pass | fix pass | flips |
| -------------------------------------- | ----- | --------- | -------- | ----- |
| `language/expressions/instanceof`       | 43    | —         | —        | +2    |
| `language/expressions/property-accessors` | 21  | —         | —        | +4    |
| `language/expressions/in`               | 36    | —         | —        | 0     |
| `language/types/object`                 | 19    | —         | —        | 0     |
| four core dirs combined                 | 119   | 75        | 81       | **+6** |
| `language/expressions/assignment`       | 485   | 332       | 335      | **+3** |
| **total**                               | 604   | 407       | 416      | **+9, 0 regressions** |

Flip list (every row, both directions — there are no regressions):

```
+ instanceof/S11.8.6_A6_T2.js                    fail          -> pass
+ instanceof/symbol-hasinstance-not-callable.js  fail          -> pass
+ property-accessors/S11.2.1_A3_T4.js            fail          -> pass
+ property-accessors/S11.2.1_A3_T5.js            fail          -> pass
+ property-accessors/S11.2.1_A4_T2.js            compile_error -> pass
+ property-accessors/S11.2.1_A4_T6.js            compile_error -> pass
+ assignment/11.13.1-4-28gs.js                   fail          -> pass
+ assignment/11.13.1-4-29gs.js                   fail          -> pass
+ assignment/11.13.1-4-6-s.js                    fail          -> pass
```

Reproducibility: the four core directories were swept twice on base by two
independent invocations (one 4-directory run, four single-directory runs). The
two agree per-file, so no cross-directory in-process pollution is present in
this sweep.

**Pins** — `tests/issue-4484.test.ts`, 27 tests, green in three configurations:
plain, `--sequence.shuffle` (order-dependence / #3673 pollution check), and
`JS2WASM_EVAL_ENGINE=interpreter` with the locally built REFUSAL provider (the
CI `quality` tier). No pin was flaky across those runs. The predecessor's
snapshot flagged "flaky/unreproducible pins" as remaining work; the file it
left already documents the three candidates it had dropped rather than pinned
(`Boolean.constructor`, the family-D closed-struct rows, and the
shadowed-`undefined` assertion weakened to "no throw"). Nothing else was
unstable — I added two pins for the @@hasInstance gate above.

**Scoped regression suites**, per-file (`tests/equivalence/` OOMs in one
invocation): `instanceof`, `in-operator-edge-cases`, `binding-null-guard`,
`assignment-expression-value`, `compound-assignment-property`,
`optional-element-access`, `hasownproperty-call`, `null-narrowing`,
`delete-operator`, `issue-3985-strict-unresolvable-assign`, `issue-4442`,
`issue-4464` — all green.

`tests/equivalence/null-dereference-guards.test.ts` fails 5 tests — **verified
pre-existing**: identical failures with the diff reverted to base.

Gates: `typecheck` clean; `check:oracle-ratchet` OK (+0 raw checker usage);
`check:coercion-sites` OK; `prettier` clean. `check:loc-budget` and
`check:func-budget` require the frontmatter allowances granted above.

## Why the row count fell short

9 of the ~30 surveyed rows, against a ≥15 bar. Two reasons, both measured:

1. **The dominant blocker in these directories is #4480's substrate, not the
   operator layer.** A plain object literal is created with `$proto = null`
   rather than the `Object.prototype` singleton, so the §7.3.20 chain walk
   finds nothing. That single missing edge accounts for `instanceof/S11.8.6_A1`
   (`({}) instanceof Object`), `S11.8.6_A2.4_T1`/`_T4`, `in/S8.12.6_A2_T1`/
   `_T2`, and `types/object/S8.6.2_A1`/`_A2`. The family-D `in` guard is
   correct and lands, but flips nothing on its own: `S11.8.7_A2.4_T1` stops
   throwing wrongly and then still answers `false`, because
   `"MAX_VALUE" in Number` needs real property presence on the builtin carrier.
2. **The survey predates the #4479/#4480 wave now on main.** This branch is
   based after that wave, so part of the original ~30 was already fixed and
   could never flip again here.

## Residuals

- **#4480 (prototype linkage)** — every row in reason 1 above. The `it.fails`
  pins in `tests/issue-4484.test.ts` hold three of them.
- **#4479 (descriptor attributes)** — `types/object/S8.6.2_A8`
  (prototype-of-non-extensible mutation).
- **Closed-struct object literals, JS lane only** — `types/object/S8.6_A2_T1`,
  `_A3_T1`, `_A4_T1`: an object literal lowers to a closed struct, so an
  expando read answers `null` instead of `undefined` and `for-in` over a grown
  literal counts 1 instead of 3. Deliberately NOT pinned: both shapes PASS in
  the TS harness (`: any` opens the object), and an `it.fails` pin that passes
  is worse than no pin.
- **Implicit-global assignment does not round-trip** — blocks
  `instanceof/S11.8.6_A2.4_T4` independently of the prototype edge. Pinned
  `it.fails`.
- **Boxed-primitive receivers** — `property-accessors/S11.2.1_A3_T1`/`_T2`
  (`true.toString()`, `new Boolean(true).toString()`). The bare-primitive forms
  work in the TS lane; these fail in the JS lane through the wrapper-object
  path, which is #4492's surface, not this operator layer.
- **`Symbol.hasInstance` dispatch is not implemented** — `to-boolean`,
  `get-err`, `invocation` still fail. This issue only stops them being
  answered with a wrong THROW; actually calling the handler needs the runtime
  `GetMethod` path.

## Lead decision (2026-08-16 03:40) — accepted as partial at +9, per the #4480 precedent

The shortfall is structural, not unfinished work: the survey predated the
#4479/#4480 wave (part already fixed), and the dominant remaining blocker —
the missing `{}` -> `Object.prototype` [[Prototype]] edge, accounting for
S11.8.6_A1, A2.4_T1/_T4, in/S8.12.6_A2_T1/_T2, types/object/S8.6.2_A1/_A2 —
is representation-level and now ROUTED TO #4506 (fnctor instances as
$Objects / prototype-chain substrate). The @@hasInstance over-throw catch
(found by error-text diffing on unflipped rows) and the fresh-worktree
.test262-cache under-measurement finding are recorded in the campaign brief's
successor lore.
