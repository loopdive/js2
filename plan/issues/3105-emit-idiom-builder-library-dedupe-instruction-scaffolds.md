---
id: 3105
title: "Emit-idiom builder library: dedupe repeated Wasm instruction scaffolds (throw-guard x17, counter-loop x21, proxy-guard x12, hash-probe x10)"
status: in-progress
assignee: ttraenkler/dev-opus-1
sprint: current
created: 2026-07-09
updated: 2026-07-24
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

## Slice log

### Slice 1 — hash-probe advance ×10 (linear backend) — DONE (PR pending)

**Idiom chosen:** the open-addressing probe advance `idx = (idx + 1) % cap` —
the tail of every linear probe loop. Picked over throw-guard×17 /
counter-loop×21 because it is the single cleanest win: **all 10 copies are
byte-identical** (same op sequence, same `idxLocal`/`capLocal` operands, each
immediately followed by the loop back-branch `br 0`), concentrated in one
untouched file, with **zero diverged copies** to exclude. The builder is a
trivial 6-instruction return with no `blockType`/branch-depth surface.

**What landed:**

- New builder `src/codegen-linear/emit-idioms.ts` →
  `hashProbeAdvanceInstrs(idxLocal, capLocal): Instr[]` returning the exact
  six instructions: `local.get idx · i32.const 1 · i32.add · local.get cap ·
  i32.rem_u · local.set idx`. Per-backend by design (#1527) — these are
  linear-memory locals with no WasmGC analogue.
- All **10** hand-rolled advance copies in `src/codegen-linear/runtime.ts`
  migrated to `...hashProbeAdvanceInstrs(idxLocal, capLocal)` — across the
  string Map (`__map_set/get/has`), string Set, numeric Map, and numeric Set
  runtimes. **runtime.ts: 3638 → 3589 lines (−49 net;** 60 deleted / 11
  added = 10 call sites + 1 import).
- **`linear` added to the `TARGETS` matrix** of
  `scripts/prove-emit-identity.mjs` (required by this issue). The playground
  corpus is all DOM/Promise-oriented and CEs under `linear`, which would make
  the target vacuous — so a new **linear-safe corpus root**
  `scripts/emit-identity-corpus/collections.ts` (string+numeric Map & Set) was
  added; it compiles under all four targets and forces the map/set runtimes
  (added unconditionally in `codegen-linear/index.ts`) into the emitted binary.

**Byte-identity proof:** baseline written across 56 `(file,target)` records
(14 files × 4 targets), then `check` after migration → **IDENTICAL — all 56
match** (incl. `collections.ts::linear`). Non-vacuousness verified by a
perturbation test: temporarily changing the builder's `i32.const 1` → `2`
drifted **exactly** `collections.ts::linear` (sha `a3bf3f63…` → `457f53ad…`)
and nothing else, confirming (a) the corpus exercises the advance code and (b)
only the linear backend uses it. `tsc --noEmit` clean; smoke test
`tests/issue-3105.test.ts` (builder-shape + linear compile/run determinism).

**Note (out of scope):** the corpus `run()` returns 212 under `linear` vs 232
under reference JS — a pre-existing linear-backend Map-update discrepancy,
independent of this byte-identical refactor. Worth a separate issue; not
touched here.

**Remaining slices (issue stays `in-progress`):** hash-probe *initial* modulo
`idx = hash % cap` ×10 (same file, next obvious slice), throw-guard×17
(`expressions/calls.ts`), counter-loop×21, proxy-guard×12, param-object×24.

### Slice 2 — hash-probe init `idx = hash % cap` ×10 (linear backend) — DONE (2026-07-24, dev-opus-1)

**Idiom chosen:** the open-addressing probe **init** `idx = hash % cap` — the
head of every linear probe loop, computing the first slot from the key hash
before the loop begins. It is the companion to slice 1's advance (loop tail);
the "next obvious slice" the slice-1 log named.

**What landed:**

- New builder `hashProbeInitInstrs(hashLocal, capLocal, idxLocal): Instr[]` in
  `src/codegen-linear/emit-idioms.ts`, returning the exact four instructions
  `local.get hash · local.get cap · i32.rem_u · local.set idx`. Per-backend by
  design (#1527); these are linear-memory locals with no WasmGC analogue.
- All **10** hand-rolled init copies in `src/codegen-linear/runtime.ts` migrated
  to `...hashProbeInitInstrs(hashLocal, capLocal, idxLocal)` — across the string
  Map (`__map_set`/`get`/`has`/delete) & Set, and the numeric Map & Set runtimes.
  Every copy was byte-identical (same op sequence, same `hashLocal`/`capLocal`/
  `idxLocal` operands), **zero diverged copies** to exclude. **runtime.ts: 40
  inline lines → 10 call sites (−30 net;** 1 import extended, 0 new import line).
  After this slice, `codegen-linear/runtime.ts` has **zero** inline `i32.rem_u`
  (both probe idioms — head + tail — now flow through the builders).

**Byte-identity proof:** `scripts/prove-emit-identity.mjs` baseline (56
`(file,target)` records, 14 files × 4 targets) captured pre-migration, then
`check` after migration → **IDENTICAL — all 56 match** (incl.
`collections.ts::linear`, sha `743dc21e7eea` unchanged). `tsc --noEmit` clean;
`tests/issue-3105.test.ts` extended with the init-builder shape guards (5 tests
green; the Map/Set linear compile/run test exercises the init path at each loop
head, keeping the proof non-vacuous).

**Running total (slices 1+2): 20 of the ≥40 target idiom copies replaced.**

### Slice 3 — counter-loop ×6 (WasmGC, json-runtime.ts) — DONE (2026-07-24, dev-opus-1)

**Idiom chosen:** the counted-forward loop `for (; i < bound; i += step) { body }`
— a `block { loop { i>=bound → br_if 1; …body…; i+=step; br 0 } }` nest. First
WasmGC-backend slice, so it creates **`src/codegen/emit-idioms.ts`** with
`counterLoopInstrs({ i, bound, body, step? })`, returning the byte-identical
scaffold (guard `i32.ge_s`, `br_if 1`; increment `i32.const step`/`i32.add`;
`br 0`). The `body`'s own branch depths are preserved because the builder wraps
it in the identical two-level nest — several sites carry their own `br_if 1`
early-exits (digit-range / non-ws checks) that keep meaning unchanged.

**Re-audit finding (the documented remaining idioms are STALE vs current main).**
The 2026-07-09 audit's proxy-guard×12 (`object-runtime.ts`) and throw-guard×17
(`expressions/calls.ts`) have since been **consolidated** — main now has **1**
`ref.test $proxy` site and **1** `throw` op in calls.ts respectively, not ×12/×17.
The one still-real duplicated idiom outside the linear runtime was the
**counter-loop in `json-runtime.ts`**: **8** loops, of which **6 share the exact
`i32.ge_s` counted-forward scaffold** and 2 are `i32.eqz` while-loops (excluded).

**What landed:**

- New `src/codegen/emit-idioms.ts` → `counterLoopInstrs`. Per-backend (#1527).
- All **6** clean counter-loops in `src/codegen/json-runtime.ts` migrated —
  the JSON string writer (`emitJsonQuoteString`: char-scan length loop +
  escape-write loop) and the number parser (`emitJsonParsePrimitive`: skip-ws,
  integer-digit, fraction-digit, exponent-digit loops). The 2 `i32.eqz`
  while-loops are left as-is (different guard shape — not this idiom).
- New emit-identity corpus **`scripts/emit-identity-corpus/json.ts`**
  (JSON.stringify of an escapable string + JSON.parse of int/frac/exp) so the
  counter-loop proof is **non-vacuous** — the native JSON runtime is emitted
  only under standalone/wasi (the `gc`/host lane uses the V8 `JSON` import), and
  the corpus forces those loops into the standalone/wasi binaries.

**Byte-identity proof:** `prove-emit-identity` baseline (60 records) → migrate →
`check` **IDENTICAL — all 60 match** (`json.ts::standalone` sha `cfc2888e0759`,
`::wasi` `0772fc0a7e7f` unchanged). **Non-vacuousness verified** by a
perturbation: temporarily flipping the builder's guard `i32.ge_s → i32.gt_s`
drifted **exactly** `json.ts::standalone` (and wasi) and nothing else, confirming
the corpus exercises the migrated loops and only the native lanes use them; the
guard was reverted and `check` re-confirmed IDENTICAL. `tsc`/prettier/biome
clean; `tests/issue-3105.test.ts` +3 (builder shape, custom-step/body-depth
guard, standalone JSON compile+run == 14357.5) → 6 green. Functional spot-check
(standalone): `JSON.parse` of `12345`/`-67`/`3.5`/`2e3` → `12345`/`-67`/`3.5`/
`2000` (sign + fraction + exponent loops correct).

**Running total (slices 1+2+3): 26 of the ≥40 target idiom copies replaced.**
Remaining real duplication: the counter-loop in `array-methods.ts` (~15 loops,
hot file — later slice) and the `param-object×24` array-method signature
(a type refactor, not an instruction scaffold). The audit's proxy-guard/
throw-guard idioms are already consolidated (no longer ×12/×17). Issue stays
`in-progress`.
