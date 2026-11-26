---
id: 7464
title: "f64 `undefined` sentinel residuals: per-evaluation statics, `for (var …)` heads, String/JSON/typeof, same-named module `let`s"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7366, 7360, 7406]
---

# #7464 — what the f64 `undefined` sentinel still gets wrong

## Problem

RV7320 found these in round 2 of the #7366 review (PR #7320, head 67c854a91e). Each one fails on `origin/main`
313281866f too, and #7366 leaves their bytes unchanged. Every case below compiles a `number | undefined` slot (or one
with the same lowering) to an f64 that carries the `undefined` sentinel (`UNDEF_F64_BITS`), on gc and standalone.

| # | program | node | head | main |
| --- | --- | --- | --- | --- |
| 1 | `function f(set: boolean) { class C { static a: number \| undefined } const r = C.a ?? 7; if (set) C.a = 1; return r }`, then `f(true) + f(false) * 10` | 77 | 17 | 10 |
| 2 | `for (var g: number \| undefined, i = 0; i < 2; i++) { … }` inside a function | runs | the Wasm fails validation | the Wasm fails validation |
| 3 | `String(g)`, `JSON.stringify({ a: g })` and `typeof new C().a` for an uninitialised `number \| undefined`; `constructor(public a: number \| undefined)` then `new C(undefined).a === undefined` | `"undefined"`, `{}`, `'undefined'`, true | the sentinel is read as a number: NaN, or a kept key | same as head |
| 4 | two files that each declare `let g`: the dependency does `g = 6`, the entry reads its own `g ?? 4` | 46 | 66 | 66 |

## Cause

1. **Per-evaluation statics.** A class declared in a function body gets its static `undefined` seed once, from the
   module prologue, and not each time the class declaration is evaluated.
2. **`for (var …)` heads.** `hoistVarDeclarations` gives a `number | undefined` var an externref slot and stores
   `undefined` into it at function entry. `compileForStatement` then retyped that slot to f64, so the entry store
   failed validation. This holds for one binding or several (re-measured 2026-11-26; the earlier note that the
   single-binding head is correct was wrong).
3. **Readers of the sentinel.** `String()`, `JSON.stringify` (a property holding `undefined` must be skipped),
   `typeof`, and the parameter-property assignment read the raw f64 and do not test for the sentinel. These are the
   sentinel readers that #7360 and #7366 did not audit. #7406 is the boolean counterpart.
4. **Same-named module `let`s.** `ctx.moduleGlobals.get(name.text)` keys module globals by bare name across files, so
   two files' `let g` share one global, and the #7366 seed inherits that lookup. This is the bare-name keying failure
   that #3364 fixed for widening.

## Acceptance criteria

- Each row above answers like node on gc and standalone.
- Every row is pinned by a test, and the pins fail on `origin/main` 313281866f.
- No test262 byte change outside the affected shapes.
- The reviewer's nits from the same round are folded in, or answered:
  - `moduleF64UndefinedSeedGlobals` walks the program three times per compile (declarations.ts, the prologue gate,
    the emit). One walk is enough.
  - `class-bodies.ts` and `class-constructor-wrapper.ts` still write the sentinel inline. They should call
    `pushUndefF64`, as the seed and the loops do.
  - The header of `module-var-undefined-seed.ts` (lines 46–51) still lists the f64 slot as an open residual.

## Implementation Plan

Re-measured on origin/main 6694a8b839 (2026-11-26); every row reproduces on gc and standalone.

| Case | Module | Change |
| --- | --- | --- |
| 1 | `declarations/module-var-undefined-seed.ts`, `statements/nested-declarations.ts` | The seed registry keeps each static's declaration. `emitClassStaticF64UndefinedSeeds` re-seeds a function-local class's statics at each evaluation, before its static initialisers. Reuses `pushUndefF64` and the existing registry; there is no second list. |
| 2 | `statements/loops.ts` | A `var` head that reuses a hoisted externref slot keeps that type, as the `seedUninitialisedForLet` doc already says. |
| 3 | the shared sentinel readers (String/concat coercion, JSON, `typeof`) and the parameter-property store | Test the sentinel where an f64 is read as a value, reusing `emitIsUndefF64`/`f64MayHoldUndefined`. |
| 4 | module-global keying | Key module globals per file, following #3364, through one helper. |

Code-quality criterion: no new predicate or seed list beside the existing ones, no budget grants, gc bytes
unchanged outside the affected shapes (checked on 240 test262 files × gc/standalone).

Out of scope, noted: `` `${g}` `` with `g: number | undefined` is a compile error ("Template literal numeric
substitution requires number_toString"). `static a: number` (no `undefined` in the type) is not re-seeded either.
