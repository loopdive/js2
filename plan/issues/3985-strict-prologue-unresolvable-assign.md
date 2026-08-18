---
id: 3985
title: "'use strict' prologue inside a function body does not take effect for unresolvable assignment"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/g-prologue
goal: core-semantics
---

# `'use strict'` prologue inside a function body does not take effect

## Problem

A `"use strict"` directive prologue **inside a function body** is detected
correctly by the compiler, but the strict branch of the assignment lowering is
missing. An assignment to an identifier the compiler cannot resolve silently
**allocates a fresh Wasm local** instead of throwing `ReferenceError`.

```js
function fun() {
  "use strict";
  test262unresolvable = null;   // must throw ReferenceError
}
assert.throws(ReferenceError, function () { fun(); });   // ← no exception thrown
```

Signature: `Test262Error: Expected a ReferenceError to be thrown but no
exception was thrown at all`.

This is a **silent wrong answer, not a refusal** — nothing downstream can
detect it. The generated Wasm is valid; it just computes the wrong thing.

## This is a BOTH-LANES defect

Every file in the family shows **standalone-only = 0** — i.e. they fail the
**default** (JS-host / WasmGC) lane too, not just standalone. Measured on
`upstream/main` @ `e240e7525` with `runTest262File` (status is the trustworthy
half of that instrument):

```
lane=default   7/22 pass   (15 genuine failures + 7 legitimate passes/controls)
```

So this is a shared **front-end scope-analysis** defect, upstream of either
backend. Consequences:

1. It counts against **both lanes'** conformance — the same fix pays twice.
2. It is fixable **without touching standalone codegen** — small blast radius
   compared with the other levers in the standalone-gap queue.
3. It is NOT part of the standalone-gap program (#2860); filing it there would
   mis-attribute it and hide the default-lane half.

## Root cause

`src/codegen/expressions/assignment.ts`, identifier-assignment path:

```ts
// line 577 — the SLOPPY branch, correctly gated on !isStrictContext
if (!isStrictContext(expr.left, ctx.inferModuleStrictArguments) && isUnresolvableIdent(ctx, fctx, expr.left)) {
  (ctx.sloppyImplicitGlobals ??= new Set()).add(name);
  ...  // §6.2.5.6 PutValue: creates a property on the global object
}

// line 602 — the catch-all fallback that STRICT falls into
{
  const resultType = compileExpression(ctx, fctx, expr.right);
  if (!resultType) return null;
  const newLocalIdx = allocLocal(fctx, name, resultType);   // ← silently swallows the error
  fctx.body.push({ op: "local.tee", index: newLocalIdx });
  return resultType;
}
```

`isStrictContext` itself is **correct** — verified directly against the repro
AST, it returns `true` for the assignment inside `fun` under both
`inferModuleStrict` settings. The defect is the *missing strict arm*, not the
strictness detection. There is no `else` for "strict **and** unresolvable"; it
falls through to a fallback whose comment describes a different case entirely
(class/object method bodies referencing outer-scope variables not yet
captured).

That fallback must be preserved for its real case: it is reached whenever
`isUnresolvableIdent` is **false** (the TS checker resolves the name but
codegen has no slot for it). Gating the new strict arm on
`isUnresolvableIdent(...) === true` keeps those on the existing path.

## Why a static throw is wrong — the fix must be runtime-checked

`isUnresolvableIdent` is a **compiler-knowledge** predicate, not the spec
predicate. Per §9.1.1.4 `GlobalEnvironmentRecord.HasBinding`, a name that
exists as a property of the global object at *runtime* IS resolvable, even
when no declaration is visible to the checker. So a compile-time
`throw ReferenceError` would be a new class of wrong answer.

The lowering therefore mirrors §13.15.2 + §6.2.5.6 exactly:

1. `has := __extern_has(globalEnvObject, "name")` — captured **before** the RHS.
   §13.15.2 resolves the LHS Reference *first*; computing HasBinding after the
   RHS lets an RHS that adds the property change the decision (this is the same
   trap that regressed `S11.13.1_A6_T3` for the dynamic-`with` gate, see
   `emitCaptureWithHasBinding` in `src/codegen/with-scope.ts`).
2. Evaluate the RHS — its side effects are observable **before** the throw.
3. `if (has) { __extern_set(obj, name, rhs); }`
   `else { throw ReferenceError("name is not defined"); }`

`__extern_has` (HasProperty — own **and** prototype chain) is the right
predicate, not `__hasOwnProperty`: the global object inherits from
`Object.prototype`, so `toString = 1` in strict code must **not** throw.
`__extern_has` is available in both lanes (host import in `src/runtime.ts`;
native arm in `src/codegen/object-runtime.ts`), so the fix stays backend-
agnostic.

## Population — enumerated, not extrapolated

The fix is inert unless the source contains a **simple `=` assignment whose LHS
is a bare identifier with no visible declaration, in strict code**. Files
without that shape compile byte-identically, so a static scan converts the
estimate into an enumerated population.

`.tmp/gprologue/enum2.mts` scanned **53,010** `.js` test files (41,155 passed
the cheap prefilter, 0 parse failures):

| Bucket                                                     | Files |
| ---------------------------------------------------------- | ----- |
| Lexically strict (nested `use strict` prologue / class / file) | 30 |
| Strict only in test262's **strict rerun** (sloppy primary)  |   120 |
| **Total the fix can possibly touch**                        | **153** |

**Positive control: 12/12.** Every file that actually flipped falls inside the
trigger set. This matters because the *first* version of the enumerator scored
11/12 — it unioned **all** harness declarations including nested parameters, so
the common short name `b` counted as "declared" and silently excluded
`8.7.2-3-a-1gs.js`. Restricting the harness scan to top-level declarations
fixed it. A single miss in a positive control is the difference between an
enumerated population and a number that merely looks like one.

So this is **~14× the reported 11 files** — worth more than its headline, but a
bounded cleanup, not a program-scale lever.

### What is NOT in this family

Three files carried the same *signature* (`Expected a ReferenceError … no
exception`) but a different *mechanism*, and are untouched by this fix:

- `language/types/reference/8.7.2-1-s.js` — `eval("_8_7_2_1 = 11;")`; the
  eval-inline path, not the assignment path.
- `language/statements/block/S12.1_A2.js` — `x()`, an undeclared **call**; the
  identifier *read* path, and not strict-specific.
- `language/eval-code/direct/var-env-var-strict-caller-2.js` — eval var-env.

Signature-clustering is not mechanism-clustering.

## Measurements

Instrument: `runTest262File` (its pass/fail **status** is the trustworthy half;
its error category and source location are not). Arm A / arm B are a **paired
per-file A/B in one process** driven by a collection-time kill switch, so
attribution is by **removal**, not by a delta against a stored baseline.

Base: `upstream/main` (not the 2026-08-01 baseline jsonl, which predates the
day's merges).

Over the enumerated trigger set (150 files) + 5 in-sweep controls:

| Lane       | Arm A (kill switch ON) | Arm B (fix) | Net | Lost |
| ---------- | ---------------------- | ----------- | --- | ---- |
| default    | 104 / 155              | 118 / 155   | +14 | 0    |
| standalone | 104 / 155              | 118 / 155   | +14 | 0    |

Row floor: **155/155 files scored in both arms, both lanes.** No
`compile_timeout` in any arm. Controls unmoved (`10.1.1-1-s.js`,
`S13_A2_T1.js`, `S11.13.1_A6_T3.js` pass→pass; `S12.10_A1.1_T1.js` fail→fail).

The 14 gains are identical in both lanes: 11 `directive-prologue/*-runtime.js`,
`types/reference/8.7.2-3-a-1gs.js`, and two the enumeration surfaced that the
report did not name — `expressions/arrow-function/strict.js` and
`statements/class/definition/constructor-strict-by-default.js`.

**Identical numbers in both lanes is the evidence for the both-lanes claim** —
a standalone-only A/B would have reported half the value.

### Instrument caveat 1 — a background-task "completed" banner is NOT the command's exit code

The refactor below moved `findUnresolvableIn{Object,Array}Pattern` out of
`assignment.ts`; `src/codegen/statements/for-of-destructuring.ts` still imported
them from there. `npx tsc --noEmit` was run and its output file recorded
`EXIT=2` on its **first line** — but the harness's background-task notification
said *"completed (exit code 0)"*, because that is the **wrapper shell's** status,
not `tsc`'s. Reading the banner instead of the record cost a full A/B run, which
died at module-load with `SyntaxError: does not provide an export named …`.

This is the `never pipe a command whose exit status you need` family in a new
shape — the redirect-to-file discipline worked exactly as intended and produced
the right record; the failure was in trusting a *different*, adjacent signal
that happened to be nearby and green. **Read the record you deliberately wrote.**

### Instrument caveat 2

One "control" in the sweep, `expressions/assignment/S11.13.1_A7_T3.js`, does
not exist; it scored `THREW: ENOENT` in both arms. It is reported here as an
artifact rather than quietly dropped — an unreadable row is not a passing row.

## Acceptance criteria

- [x] The measured failures flip to pass in the **default** lane (+14).
- [x] Same files measured in the **standalone** lane (+14, identical set).
- [x] In-sweep controls do not move.
- [x] Attribution proven by kill-switch **removal**, not just by the delta.
- [x] The regression test is itself controlled: with the kill switch on,
      exactly 14 of its 28 cases fail (the 7 behavioural cases × 2 lanes) and
      the 14 control cases still pass — so it is not vacuous.
- [x] A final arm with the measurement scaffold deleted.

### Final arm — scaffold deleted

The kill switch was removed from the compiler entirely (`grep` for
`JS2WASM_DISABLE_3985` across `src/`, `tests/`, `scripts/` returns nothing) and
the trigger set re-run single-arm on the shipped code:

| Lane       | Final (scaffold deleted) | Expected gains held | Row floor |
| ---------- | ------------------------ | ------------------- | --------- |
| default    | 118 / 155                | 14 / 14             | 155 / 155 |
| standalone | 118 / 155                | 14 / 14             | 155 / 155 |

Exactly reproduces arm B, so the scaffold was never load-bearing. The A/B was
also re-run in full **after** the module extraction (104 → 118, +14, 0 lost),
confirming the refactor is behaviour-preserving.

## Implementation notes — why it is shaped this way

**Why not a static throw.** The obvious fix — `emitThrowReferenceError` when
strict and unresolvable — would be a *new* class of wrong answer.
`isUnresolvableIdent` asks "does the compiler know this binding", the spec asks
"does the environment chain have it at run time". Those differ whenever a
global is installed outside the TypeScript program.

**Why `__extern_has` and not `__hasOwnProperty`.** The neighbouring
`emitImplicitGlobalRead` uses `__hasOwnProperty`, which was the tempting thing
to copy. It would be wrong here: `GlobalEnvironmentRecord.HasBinding`
(§9.1.1.4.1) delegates to the object Environment Record, whose HasBinding is
**HasProperty** (§7.3.12) — prototype chain included. The global object
inherits from `Object.prototype`, so `toString = 1` in strict code resolves and
must not throw. There is a regression test for exactly this.

**Why HasBinding is captured before the RHS.** §13.15.2 step 1.a resolves the
LHS Reference *before* step 1.e evaluates the RHS. Computing HasBinding
afterwards lets an RHS that adds the property to the global object change the
binding decision. That is not hypothetical — it is the mis-lowering that
regressed `S11.13.1_A6_T3` for the dynamic-`with` gate, documented on
`emitCaptureWithHasBinding` in `src/codegen/with-scope.ts`. That test is an
in-sweep control here and does not move.

**Why the catch-all fallback survives.** The pre-existing fallback (auto-allocate
a local) is reached whenever `isUnresolvableIdent` is **false** — the TS checker
resolves the name but codegen has no slot for it, e.g. class/object method
bodies referencing outer-scope variables not yet captured. Gating the new arm on
`isUnresolvableIdent === true` leaves those on the old path untouched. The
`[lane] a strict function writing an outer var is unaffected` and
`[lane] a class body is strict without any prologue` tests pin both sides.

**Why a new module instead of a budget allowance.** The change pushed
`assignment.ts` past its god-file LOC budget (5185 > 5128) and
`compileAssignment` past its function budget (477 > 431). Rather than granting
an allowance, the sloppy and strict arms moved together into
`src/codegen/expressions/unresolvable-assign.ts`. They are one decision sharing
one predicate and one carrier — and keeping them in separate places is
precisely how the strict half stayed missing. Both budget gates pass with no
allowance.

### Pre-existing failure NOT caused by this change

`node scripts/profile-godfiles.mjs --check` fails on
`src/codegen/index.ts#generateMultiModule` (+52) and `#planIrOverlay` (+78).
`src/codegen/index.ts` is **byte-identical to `upstream/main`** on this branch,
and `check:godfiles` is a `package.json` script not wired into any workflow, so
it does not gate this PR. Flagged for the tech lead rather than silently
absorbed.

### Fork/upstream issue-id split-brain (also not caused by this change)

`node scripts/check-issue-ids.mjs --against-main` fails **locally** in this
worktree with 5 collisions — #3973, #3974, #3977, #3980, #3982 — none of them
#3985. The cause is that in this checkout `origin` is the **fork**
(`ttraenkler/js2`), whose `main` has drifted, and it holds *different* issue
files at those five ids than `loopdive/js2` does. Against `upstream/main` this
branch adds exactly **one** issue file (this one), and #3985 does not exist
upstream — so the CI gate, which resolves `origin` to `loopdive/js2`, sees no
collision. Worth flagging: anyone branching from the **fork's** `main` would
inherit five genuinely duplicated ids.
