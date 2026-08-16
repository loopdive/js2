---
id: 4489
title: "standalone: module-scope `var x;` reads before declaration are `ref.null.extern`, indistinguishable from the closure ABI's absent-arg pad — seed with the undefined singleton (full-corpus A/B required)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: hoisting
goal: standalone-gap
related: [4465, 737]
origin: "2026-08-15 #4465 R1 finding — 5 measured rows in built-ins/String/prototype alone; the root is module-wide."
---

# #4489 — module globals seed null, not undefined

## Problem

`registerModuleGlobal` seeds externref module globals with `ref.null.extern`.
A hoisted-but-unassigned `var x;` read therefore yields the same value the
closure ABI uses as its "absent argument" pad, so downstream arms
(String.prototype methods among them, #4465 G1b/G3, 5 measured rows) cannot
distinguish `undefined` from "no argument", and `String(x)`-class coercions
answer wrong. The function-local hoister already seeds `undefined` (#737) —
module scope diverges.

## Why this is NOT a one-line ship despite a one-line fix

The candidate fix is one line (seed with the undefined singleton), but its
blast radius is EVERY module global in the corpus: any arm that currently
`ref.is_null`-tests a module global to mean "unset" changes behavior. #4465's
agent measured only a 630-file String-scoped sweep and correctly declined to
ship blind.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md`.
2. Find every consumer that null-tests module globals (grep the emission
   sites reading `moduleGlobal`/`registerModuleGlobal` slots; catalogue
   `ref.is_null` uses on those values).
3. Apply the seed change; fix consumers that meant "unset" rather than
   "undefined" (they must test against the undefined singleton or a
   separate flag).
4. **Full-corpus A/B is the acceptance instrument**: a broad standalone
   sweep (at minimum: `built-ins/String`, `language/statements`,
   `language/expressions`, `built-ins/Object`, ~2k files) before/after from
   your own runs, zero regressions; plus the 5 #4465 R1 rows flipping.
5. Pins: extend tests/issue-4465.test.ts's residual pins (R1 has no pin —
   the harness's exported-function shape masks it; write a
   module-init-shape pin that actually exercises the module-global path,
   documented in #4465's report).

## Acceptance criteria

- The 5 R1 rows flip; broad-sweep zero regressions; consumers catalogued in
  the issue file.

## Consumer catalogue (step 2 — done BEFORE the seed changed)

The plan's framing ("every consumer that null-tests module globals") has two
populations, and separating them is what makes the blast radius bounded rather
than corpus-wide.

**A. Slots that are NOT user `var`s.** `ctx.moduleGlobals` is not only user
variables — the compiler parks internal state in the same map, and those
entries genuinely mean "unset" by nullness:

| Slot | Site | `ref.is_null` means | Disposition |
| --- | --- | --- | --- |
| `"\0runtime-eval-carrier-memo"` | `runtime-eval-callable.ts:377` (`memoHit`) | memo empty | **Excluded by construction** — the seed loop iterates `recordScriptVarBindingNames`, and a NUL-prefixed name is not a JS identifier, so it can never appear there. |
| `__captured_<name>` | `closures.ts:788` | never read — the promotion `global.set`s the local's current value on the next instruction | Not in `moduleGlobals` at all (`capturedGlobals`); untouched. |
| `__tdz_<name>` | `module-global-registration.ts:119` | binding not yet initialised | `i32` flag, not externref; untouched. |

**B. User `var` slots — consumers of the pre-assignment value.** Every one was
read at the emission site and, where behaviour could differ, probed on the
compiled module (`.tmp/p2`–`p6`, standalone lane, this box):

| Consumer | Site | Before (null) | After (singleton) |
| --- | --- | --- | --- |
| Annex B block-fn `typeof` | `typeof-delete.ts:1440` | null arm → `"undefined"` | already singleton-seeded by the #4182 loop; its own comment states the null arm is dead standalone. **No change.** |
| closure call `f()` on a `var f` slot | `calls-closures.ts:590-604` | `emitGuardedRefCast` → null → `emitNullCheckThrow` TypeError | the singleton fails the same `ref.test`, yields null, throws the same TypeError. **No change.** |
| slot-type queries (`inferExpressionWasmType`, `compoundSlotValType`, the `subarray`/HOF receiver probes) | `array-methods.ts:955/1473/1578`, `string-compound-lane.ts:36`, `index.ts:10788` | read `global.type`, never the value | **No change.** |
| sloppy `this` substitution | `helpers/sloppy-this-global.ts:159` warns the singleton IS non-null and defeats a callee's `ref.is_null` §10.4.3 fallback | probed: `f.call(x)`, `f.call(undefined)` and `f()` already agree (all three leave `this === undefined` true), so the fallback is not live in this shape | **No change** — and the singleton arm is the one that matches `f.call(undefined)`. |
| `x === undefined` / `x === null` | strict-eq dispatch | `false` / `true` — **both wrong** | `true` / `false` — **both fixed.** |
| `x == null`, `String(x)`, `x + ""`, `` `${x}` ``, `typeof x`, `"s".concat(x)` | nullish-widened S1 consumers | already answered as if `undefined` | **No change** (the #2106 widening already covers null). |
| ~~`x()`~~ — see the correction below | call dispatch | — | — |
| trailing call argument | user closures and the reflective String ABI (`string-proto-concat.ts` §22.1.3.5 step 3 pad) | indistinguishable from "argument not passed" — argument dropped | passed as a real `undefined`. **The #4465 R1 fix.** |
| `x.foo` | member dispatch | does not throw — but neither does `undefined.foo` today | **No change**; pre-existing gap on BOTH values, recorded as a residual. |

### Catalogue corrections and additions (second pass — every row below is a run I executed)

The table above was written from the emission sites; three of its rows were not
confirmed against a compiled module, and the two families with the largest
blast radius were missing entirely. The A/B instrument for all of the following
is the same one the sweep uses: one process, `JS2WASM_4489_AB=base` selecting
the pre-fix emission, both variants compiled and instantiated back to back
(`.tmp/probe-semantics.mts`, `.tmp/probe-shadow-builtin.mts`,
`.tmp/probe-call-and-assign.mts`, `.tmp/probe-reflective-tostring.mts`).

**Correction — `x()` does NOT start throwing.** Measured, module-init shape:
`x()` on a pre-declaration `var x;` throws nothing on EITHER side, while a
literal `undefined()` and `null()` both throw a real TypeError on both sides.
So the missing throw is a defect in the CALL dispatch of a global slot, not a
property of the value it holds, and this issue neither fixes nor worsens it.
(`var f; f(); f = function(){}` throws a non-TypeError on both sides —
separately pre-existing.)

**Addition — truthiness. The family that had to NOT move, and didn't.** `null`
and the singleton are both falsy, so every one of `if (x)`, `!x`, `x ? :`,
`Boolean(x)`, `while (x)`, `x || 7`, `x && 7` was already right before the seed
and stays right after it. This is the row that would have made the change
un-shippable had it moved, because it is the only one where the pre-state was
CORRECT; it is now pinned in `tests/issue-4489.test.ts`.

**Addition — numeric coercion. The family where the two values genuinely
disagree.** `Number(null)` is 0 but `Number(undefined)` is NaN, and test262
scores the difference:

| Expression | Before (null) | After (singleton) | Spec |
| --- | --- | --- | --- |
| `Number(x)` | `0` | `NaN` | `NaN` |
| `x + 1` | `1` | `NaN` | `NaN` |
| `+x` | `0` | `NaN` | `NaN` |
| `x < 1` | `true` | `false` | `false` |
| `[undefined].indexOf(x)` | `-1` | `0` | `0` |

**Addition — §9.1.1.4.18 non-clobber (`var Math;`).** CreateGlobalVarBinding
must not overwrite a name that is already a global property, so a seed that
reached those slots would be a regression. Measured unchanged on both sides for
`var Math;`, `var Array;`, `var JSON;`, `var Object;`, `var String;`
(`Math.max`, `Array.isArray`, `JSON.stringify`, `Object.keys`, `String(42)` all
keep working); `var NaN;` incidentally IMPROVES (`isNaN(NaN)` false → true,
because the shadow slot now reads `undefined` rather than `null`). Pinned.

**Addition — reflective String-method ToString renders the singleton as
`"[object Object]"`.** Not caused here and not fixed here, but it is what keeps
3 of the 5 R1 rows red, so it belongs in the catalogue: with an OBJECT
`searchValue` (or a detached `String.prototype.replace.call`) the replacement
value's ToString takes a generic-object arm. Provenance is irrelevant to it,
which is the proof it is not this issue's: an ABSENT ARGUMENT's `undefined` — a
value this seed cannot reach — already renders `"[object Object]"` there on
BOTH sides. Effect of this change on those rows is `"null…"` → `"[object
Object]…"`: a wrong answer replaced by a different wrong answer, no status
movement. The direct arm (string `searchValue`) is correct.

**Addition — an assignment that PRECEDES the `var` statement is lost, on both
sides.** `x = 5; … var x;` reads back neither `5` nor its seed: base gives the
null extern (`typeof` "object"), after the change it gives `undefined`. Both
are wrong (spec: `5`), the loss predates this issue, and the seed only changes
which wrong value is observed. Recorded as a residual, not a regression.

The load-bearing conclusion: the #2106 S1 sweep already flipped every
*nullish-intent* consumer to `is_null ∨ is-singleton`, so the change moves a
value from a widened-accepted representation to the canonical one. The
consumers that behave differently are exactly the ones that were **wrong**
before (`===`, numeric coercion, argument passing), which is why a one-line
seed is nevertheless a real change and needed the corpus A/B.

## Root cause

`registerModuleGlobal` can only give a module global a CONSTANT initializer,
and the only constant externref is `ref.null.extern`. Under the #2106 S1 value
model that is `null` — a genuinely different value from the tag-1 `$undefined`
singleton, not another spelling of it. §9.1.1.4.18 CreateGlobalVarBinding
requires every module-scope `var` to hold `undefined` before the first
top-level statement runs, so the constant init is a value the spec never
permits to be observable there. The function-local hoister has seeded a real
`undefined` since #737; module scope simply never got the same treatment, and
the #2106 nullish-widening (`is_null ∨ is-singleton` in every nullish-intent
consumer) hid the divergence everywhere except where the two values are
genuinely distinguishable: `===`, numeric coercion, and argument passing.

## Fix

`src/codegen/declarations/module-var-undefined-seed.ts` —
`emitModuleVarUndefinedSeeds` writes the singleton into every externref module
global backed by a module-scope `var`, in the `__module_init` PROLOGUE, and is
called from `compileDeclarations` where the #4264 `with`-body-only seed used to
sit (it subsumes that seed: `scriptVarBindingNames` walks the same region over
a superset of declarations). `scriptVarBindingNames` in
`source-scan-predicates.ts` is the memoized set form of the existing
`recordScriptVarBindingNames` walk.

Three scope decisions, each load-bearing:

- **Prologue, ahead of the function-binding seeds** (#2931 live bindings, #4394
  script globals, #4182 Annex B). §9.1.1.4.18 creates a `var` binding with
  `undefined` only when the name is absent, and GlobalDeclarationInstantiation
  initialises function bindings afterwards, so a name that is both must end up
  holding the FUNCTION. Pinned.
- **`var` only.** `let`/`const` must be in TDZ before init, which the separate
  `__tdz_<name>` flag enforces; seeding them `undefined` would be wrong.
- **externref slots only.** A slot narrowed to a primitive (`var n = 42` ⇒
  `(mut f64)`) cannot hold the singleton and keeps its wasm zero-init — the
  module-scope twin of #684, left as a residual because the remedy is a
  slot-type change with its own blast radius.

Standalone/WASI only: in host mode `undefined` IS the null extern, and the
singleton would surface to host helpers as an object (#4264's grounds).

## Residuals

1. **Reflective String-method ToString renders the undefined singleton as
   `"[object Object]"`** — the blocker for 3 of the 5 R1 rows. Filed as the
   stub below; needs its own id.
2. **A primitive-narrowed module `var` still reads its wasm zero-init**
   (`var n = 42` before the declaration reads `0`, not `undefined`). Module
   scope twin of #684; `it.fails`-pinned in `tests/issue-4489.test.ts`.
3. **An assignment that precedes the `var` statement is lost** (`x = 5; … var
   x;` reads back the seed, not `5`) — pre-existing on both sides; the seed
   only changes which wrong value is observed (`null` → `undefined`).
4. **`x()` on a pre-declaration `var x;` throws nothing**, while a literal
   `undefined()` throws TypeError — a call-dispatch gap on global slots,
   unchanged by this issue and unrelated to the value held.
5. **`x.foo` does not throw**, and neither does `undefined.foo` — pre-existing
   on both values.

## New-issue stub — reflective String-method ToString of `undefined`

*(needs an id from `claim-issue.mjs --allocate`; the session lead allocates at
merge time.)*

- **title**: `standalone: the reflective String.prototype.{replace,concat} arm
  renders the undefined singleton as "[object Object]"`
- **goal**: `standalone-gap` · **area**: codegen · **es_edition**: 5
- **Problem.** With an OBJECT `searchValue` — or a detached
  `String.prototype.replace.call` receiver — the replacement value's ToString
  takes a generic-object arm that does not recognise the tag-1 `$undefined`
  singleton, so a genuine `undefined` renders `"[object Object]"` instead of
  `"undefined"`. The direct arm (string `searchValue`) is correct.
- **Provenance-independent, therefore not #4489's.** Measured on this box, both
  before AND after #4489's seed, with the undefined sourced from an ABSENT
  ARGUMENT — a value the seed cannot reach:

  | shape | before #4489 | after #4489 | spec |
  | --- | --- | --- | --- |
  | direct arm, module `var` | `"null…"` | `"undefined…"` | `"undefined…"` |
  | direct arm, absent arg | `"undefined…"` | `"undefined…"` | `"undefined…"` |
  | reflective arm, absent arg | `"[object Object]…"` | `"[object Object]…"` | `"undefined…"` |
  | reflective arm, module `var` | `"null…"` | `"[object Object]…"` | `"undefined…"` |
  | detached `.call`, module `var` | `"[object Object]…"` | `"[object Object]…"` | `"undefined…"` |

- **Blocks**: `built-ins/String/prototype/replace/S15.5.4.11_A1_T10.js`,
  `.../S15.5.4.11_A1_T9.js`, `built-ins/String/prototype/concat/S15.5.4.6_A1_T10.js`
  (the last also needs ToString of an object whose `toString` returns a
  non-string primitive — `{toString:function(){return true;}}` renders
  `"[object Object]"` instead of `"true"`, same arm).
- **Pin already in tree**: the `it.fails` case
  `residual: reflective String.replace renders undefined as "[object Object]"`
  in `tests/issue-4489.test.ts`, which carries the absent-arg control.
- **Repro**: `.tmp/probe-reflective-tostring.mts` (see #4489's record).
