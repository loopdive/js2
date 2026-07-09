---
id: 3105
title: "Emit-idiom builder library: dedupe repeated Wasm instruction scaffolds (throw-guard x17, counter-loop x21, proxy-guard x12, hash-probe x10)"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: high
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1849, 3104, 3108]
---

# #3105 — Emit-idiom builders: dedupe repeated instruction scaffolds

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

A windowed duplicate scan (8-line normalized windows, non-trivial only) over
`src/` finds **21,389 lines (6.9% of 309k)** inside duplicated blocks. The
top duplicated content is not business logic — it is hand-rolled Wasm
instruction _scaffolds_, re-typed at each site. Named idioms with verified
locations:

| Idiom                                                                                                                                 | Copies          | Locations (sample)                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Throw-error guard** — `addStringConstantGlobal(msg)` + `ensureExnTag` + `{op:"if", then:[...stringConstantExternrefInstrs, throw]}` | ×17 in one file | `expressions/calls.ts:11253, 11356, 11455, 15600, …`                                                                                                                          |
| **Counter-loop scaffold** — `block/loop` + `local.get i` / bound / `br_if` / body / `i+1` / `br 0`                                    | ×12 + ×9 + ×9   | `array-methods.ts:2338, 2425, 2568, 2690, …`; `json-runtime.ts:192, 343, 521, 602`; `json-codec-native.ts:1532+`                                                              |
| **Proxy guard** — `local.get 0` / `any.convert_extern` / `ref.test $proxy` / `if`                                                     | ×12             | `object-runtime.ts:8211, 8233, 8260, 8288, …`                                                                                                                                 |
| **Hash-probe advance** — `idx+1 % cap` open-addressing step                                                                           | ×10             | `codegen-linear/runtime.ts:2182, 2281, 2304, 2372, 2396, …` (map/set/numeric-map/numeric-set runtimes are 4 near-copies; the file is **24% duplicated lines**, worst in src/) |
| **Long duplicated param lists** — `(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, …)`                                      | ×24             | `array-methods.ts:3694, 3833, 4143, 4248, …`                                                                                                                                  |

Supporting counts: `addStringConstantGlobal` 186 sites,
`stringConstantExternrefInstrs` 153 sites, `ensureExnTag` 85 sites across
`src/codegen/`.

Beyond LOC, hand-expanding these idioms is a bug surface: each copy re-derives
branch depths and local indices by hand (the exact class of bug the peephole /
stack-balance layers exist to catch).

## Fix

Create `src/codegen/emit-idioms.ts` (WasmGC) and
`src/codegen-linear/emit-idioms.ts` (linear — backends stay separate per
#1527; the _builders_ are per-backend, only genuinely rep-independent helpers
may live in a shared file):

```ts
// returns the exact instruction sequence the sites hand-roll today
throwErrorIfInstrs(ctx, cond: Instr[], msg: string, errorKind): Instr[]
counterLoopInstrs(opts: {i: LocalIdx; bound: Instr[]; body: Instr[]; step?: number}): Instr[]
proxyGuardInstrs(ctx, paramIdx: number, thenBody: Instr[]): Instr[]
// linear:
hashProbeAdvanceInstrs(idxLocal, capLocal): Instr[]
```

Plus one params-object type for the ×24 duplicated array-method signature
(`interface VecCallSite { propAccess; callExpr; vecTypeIdx; arrTypeIdx; … }`).

**Migration is per-idiom, per-file slices**: replace each hand-rolled copy
with the builder call; the builder must return the byte-identical sequence
(same ops, same operand order, same blockType).

## Safety story (byte-identity provable)

This is the canonical use case for `scripts/prove-emit-identity.mjs`:

1. Baseline before each slice.
2. Replace N copies of ONE idiom in ONE file.
3. `check` must print IDENTICAL — any deviation (e.g. a copy that had locally
   diverged) fails loudly; a diverged copy is then EXCLUDED from that slice
   and documented (divergence is either a latent bug → file separately, or an
   intentional variant → parameterize).
4. `tsc --noEmit` + scoped vitest per slice.

The linear-backend slices need coverage too: **first slice of this issue adds
`linear` to the `TARGETS` matrix in `scripts/prove-emit-identity.mjs`** (the
script currently proves gc/standalone/wasi only — measured 2026-07-09).

## Estimated LOC delta

Throw-guard ~17×10 + counter-loop ~30×12 + proxy-guard ~12×15 + hash-probe
~10×10 + param-object ≈ **−1,200 to −1,800 LOC** in the first wave; the
builders also stop the idioms from re-multiplying (compounding with #3102).

## Dependencies / coordination

- Independent of #2710 (no index-representation change; builders return
  literal Instr arrays).
- #1849 lists _diverged_ copy-paste (super-dispatch, closure drainers,
  `resolveVec`, `__extern_has`) — keep it separate: this issue targets
  _identical_ scaffolds provable byte-identical; #1849's diverged copies need
  semantic reconciliation first.

## Acceptance criteria

1. `prove-emit-identity check` IDENTICAL per slice (incl. `linear` target once added).
2. ≥ 40 hand-rolled idiom copies replaced by builder calls.
3. `codegen-linear/runtime.ts` duplicated-line ratio drops below 15% (from 24%).
4. No test262 regression.
