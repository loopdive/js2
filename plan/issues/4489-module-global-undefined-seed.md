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
| `x()` | call dispatch | did NOT throw; `undefined()` DID | now throws, matching `undefined()`. **Behaviour change toward spec.** |
| trailing call argument | user closures and the reflective String ABI (`string-proto-concat.ts` §22.1.3.5 step 3 pad) | indistinguishable from "argument not passed" — argument dropped | passed as a real `undefined`. **The #4465 R1 fix.** |
| `x.foo` | member dispatch | does not throw — but neither does `undefined.foo` today | **No change**; pre-existing gap on BOTH values, recorded as a residual. |

The load-bearing conclusion: the #2106 S1 sweep already flipped every
*nullish-intent* consumer to `is_null ∨ is-singleton`, so the change moves a
value from a widened-accepted representation to the canonical one. The
consumers that behave differently are exactly the ones that were **wrong**
before (`===`, argument passing, call dispatch), which is why a one-line seed
is nevertheless a real change and needed the corpus A/B.
