---
id: 2071
title: "constructor returning a foreign plain object cannot override `this` — ctor Wasm return type is (ref $Struct), needs externref-based return ABI"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: core-semantics
related: [2018, 2026]
origin: "2026-06-11 follow-up from #2018 fix (PR loopdive#1326): foreign-object override out of scope there"
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/index.ts
  - src/codegen/typed-this.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/fnctor-escape-gate.ts
oracle-ratchet-allow:
  # (#4250 companion) One more `resolveWasmType(ctx, ctx.checker.getTypeAtLocation(…))` in
  # `deriveFnctorFields` — a wasm-lowering ValType question, which is deliberately
  # above what `ctx.oracle` can express (it has no `ts.Type` accessor), and the
  # identical query the two adjacent lines already make for the FIRST write.
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  # (test262 S13.2.2_A11/A12) fnctor field slots must hold every constructor
  # write, and the constructor body must hoist its own function declarations —
  # both land in functions this issue already owns the surrounding budget for.
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
  - src/codegen/declarations/object-shape-widening.ts::scanStatements
  - src/codegen/declarations/object-shape-widening.ts::collectEmptyObjectWidening
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
---

# #2071 — `constructor() { return { x: 99 } as any; }` falls back to `this`

## Problem

Per §10.2.1.3, a constructor returning an object overrides `this` for the
`new` expression. After #2018 (PR loopdive#1326) the trap is gone and
same-class object overrides (`return this`, `return new SameClass()`)
work, but a *foreign* plain object (`return { x: 99 } as any`) is not
representable: the ctor's Wasm return type is `(ref $Struct)` and every
`new` site is hard-typed to it, so the fix falls back to returning `this`
(observable: `new A().x` → 1 instead of 99). Non-trapping but
spec-divergent.

## Root cause / constraint

Constructor return ABI. True foreign-object override requires the
constructor return type (and all `new` sites + downstream property access)
to accept an externref/any-carrier, or a dual-return scheme (struct ref +
optional override slot). Touches `compileNewExpression`
(src/codegen/expressions/new-super.ts), ctor signature emission, and the
return lowering added in #2018 (src/codegen/statements/control-flow.ts).

## Fix direction

Candidates (architect input useful, relates to #2026 first-class
constructor descriptors): (a) dual-slot return struct, (b) externref ctor
ABI with ref.cast at statically-typed `new` sites, (c) keep current ABI
and reject foreign override at compile time with a diagnostic instead of
silent `this`.

## Acceptance criteria

- `class A { x = 1; constructor() { return { x: 99 } as any; } } new A().x` → 99
  (or, if (c) is chosen, a loud compile-time diagnostic — documented decision)
- No regression in #2018's tests; `new` perf on the common path unchanged

## Dupe check

#2018 (PR #1326) explicitly documents this as out-of-scope follow-up;
#2026 (class-as-value) is the adjacent ABI family. No existing issue
covers ctor object-override representation.

## Progress (2026-08-20, function-declaration slice)

The FUNCTION-DECLARATION fnctor slice is implemented and verified in the
standalone lane (17 bespoke probes + `S13.2.2_A15_T1` all pass; the fnctor
suites' 6 failures are IDENTICAL at the pre-change merge-base — measured via
file-copy A/B, zero regressions added). Five cooperating pieces, all keyed on
ONE pure-AST predicate (`fnctorBodyMayReturnForeignObject`,
`src/codegen/fnctor-foreign-return.ts`) so ABI, typing, and proof can never
disagree:

1. **Ctor ABI widening** (new-super.ts): externref result + extern self
   mirror + `emitConstructReturnSelect` runtime probe (§10.2.1.3 step 13).
2. **Instance-type degrade** (index.ts `resolveWasmType`): foreign-return
   fnctor INSTANCE types resolve externref — and this now WINS over
   escape-gate approval. Approval says the struct layout is stable, not that
   `new F()` yields it: the approved-struct-typed binding guard-cast the
   overriding `$Object` to null (measured: every read `undefined`).
3. **Receiver-proof exclusions** (typed-this.ts seeding; fnctor-escape-gate.ts
   `buildReceiverStructMap` `new F()` pin): `new F()` proves NO struct when F
   may return foreign — the proven/pinned fast paths' field-typed narrowing
   turned an overriding `"A"` into ToNumber("A")=NaN.
4. **Member-read honesty** (property-access-dispatch.ts): with a foreign
   receiver, the access's checker type may not narrow the dynamic read
   (accessWasm → externref), same-name struct-field votes may not re-narrow
   (`preserveDynamicResultCarrier`), and no field auto-registration.
5. **Escaping-literal representation** (object-shape-widening.ts): a
   `var X = {}` RETURNED from a new'd foreign-return ctor is poisoned onto the
   open `$Object` (existing #2584/#2944 machinery), so consumers' dynamic
   reads find its properties (closed widened structs were invisible to
   `__extern_get` when the ladder compiled before registration).

**Second slice (same day):** the remaining `A15_T2/T3/T4` shapes now pass
too — the whole `S13.2.2_A15` family is green in the standalone lane:

6. **Fn-expression / assigned-later ctor spellings** —
   `foreignReturnFunctionNames(sf)` (cached per file) collects `function F`,
   `var F = function(){…}`, and `F = function(){…}`; every consumer above
   now keys on it, so `typeIsForeignReturnFnctorInstance` recognises the
   evolved instance shape TS synthesizes for `new (assigned fn-expr)()` (T3's
   `__obj.prop` was ToNumber-narrowed to NaN through it).
7. **Vote seam** (property-access-dispatch.ts Phase-3 narrowing): a
   foreign-return ctor's `__fnctor_*` struct contributes `externref` to the
   field-kind vote — same seam as the #3927 hidden-carrier fixes — because
   the same prop name is typically also written to the escaping object.
8. **Assigned-global poison** (`poisonForeignCtorAssignedGlobals`): an outer
   `var X;` (or implicit global) assigned `{}` inside a foreign-return ctor
   that `return X`s is poisoned onto the open `$Object` with its evolved
   type (and the ctor's return type) pinned in `objectHashConsumerTypes`
   (T2/T4's closed-struct global guard-cast the `$Object` to null).

`A12`/`A11` are different defects (union-typed field write; missing
`this.func` TypeError) — not this issue.

## Follow-up (2026-08-21): self-construction is not a foreign return

The predicate `fnctorBodyMayReturnForeignObject` counted the ubiquitous
**callable-as-function guard** as a foreign return:

```js
function Test262Error(message) {                       // test262/harness/sta.js
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}
```

`Test262Error` is in the assembled harness of **every** test262 file, so this
degraded every `Test262Error` binding in the STANDALONE lane to externref.
Measured knock-on: `inferParamTypeFromCallSites` then agreed `externref` for
`$DONE`'s implicit-any parameter instead of the `__fnctor_Test262Error` struct,
and **12** `test/harness/asyncHelpers-throwsAsync-*.js` rows failed with
`TypeError: Promise.prototype.then called on a non-Promise receiver`
(bisect: pass at `f2ee892b95`, fail at `a59e7491a1`; consumer isolated
empirically to the `resolveWasmType` degrade — the ctor-ABI and
property-access-dispatch arms were each switched off independently and neither
changed the verdict).

Fix: `return new F(…)` written **inside F itself** is now `obviouslyNonForeign`.
It is sound and stays purely syntactic — with `S` the value set of `new F(…)`,
the body returns either the fresh receiver (an F instance) or an element of `S`,
so `S = {F instances}` satisfies the recursion and the override substitutes
nothing the outer construct site did not already admit. Any *other*
`return <object>` in the body still trips the predicate.

Ledger (standalone lane, single-test probes on this branch):

| bucket | before | after |
| --- | --- | --- |
| `asyncHelpers-throwsAsync-*` (12 rows) | FAIL | **PASS** |
| `asyncHelpers-asyncTest-return-not-thenable` | PASS | FAIL (also FAIL at `f2ee892b95`) |
| other 8 asyncHelpers rows | unchanged | unchanged |
| `probe/v2,v8,z1,z4`, `S13.2.2_A15_T1/T3` | PASS | PASS |
| host (gc) lane, all 21 asyncHelpers + the 7 above | — | byte-for-byte same verdicts |

**Known residual — `asyncHelpers-asyncTest-return-not-thenable`.** It failed at
`f2ee892b95` with the identical `[false × 6]` message, so #2071 was masking a
*separate* latent hole rather than fixing it: `inferParamTypeFromCallSites`
narrows `$DONE`'s implicit-any parameter to `ref null $__fnctor_Test262Error`
off the single `$DONE(new Test262Error(…))` call site in `asyncHelpers.js`,
while the other call sites forward untyped identifiers that contribute nothing
to the agreement — so a real `TypeError` reaching `$DONE` is mangled and
`error instanceof TypeError` answers false. The #2867-S2 withdrawal does not
apply (`$DONE` does not escape as a value). Worth its own issue; the guard
would be "withdraw a `__fnctor_*` ref narrowing when some call site passed an
argument the scan could not type", whose corpus-wide blast radius needs a full
test262 run to size.
