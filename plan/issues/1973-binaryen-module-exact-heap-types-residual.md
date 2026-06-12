---
id: 1973
title: "optimize:true via binaryen npm module re-introduces exact heap types — optimized binaries rejected by stock V8 and JSC (#1580 masking silently no-ops)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: tooling
language_feature: compiler-internals
goal: platform
related: [1173, 1580]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main"
---

# #1973 — `Features.All` in binaryen 125 includes an unnamed custom-descriptors bit

## Problem

`-O` output fails to instantiate on stock engines for almost any non-trivial
program (closures/arrays/classes): V8 → `CompileError: invalid heap type
'exact'`; JSC/bun → `can't get Function local's type in group 2`.
`compile()` reports `success: true`; failure surfaces only at instantiation.
The npm-module path always wins over the CLI fallback (binaryen is a listed
dependency), so the #1173 CLI fix never applies in practice.

## Repro (verified on main)

```ts
export function test(): number { let acc = 0; const add = (x: number) => { acc += x; };
  for (let i = 0; i < 5; i++) add(i); return acc; }
```

`compile(src, { optimize: 3 })` → `new WebAssembly.Module(result.binary)`
throws; unoptimized binary valid, returns 10.

## Root cause

`src/optimize.ts:273-275` — `optimizeWithBinaryenModule` sets
`features = featureFlags.All` then guards
`if (featureFlags.CustomDescriptors !== undefined) features &= ~...`. binaryen
**125.0.0** does not expose a `CustomDescriptors` key in its JS Features enum
(verified: keys are MVP…CallIndirectOverlong,All), so the guard no-ops while
`Features.All` (0x3FFFFF) still includes the unnamed custom-descriptors bit
(bit 21). `mod.optimize()` then rewrites `(ref $T)` → `(ref (exact $T))`.
Masking to only the *named* feature bits empirically produces a valid binary.
#1580 claimed this masking fixed; the fix silently fails.

## Fix direction

Build the feature mask by OR-ing the named enum keys (excluding `All`) instead
of starting from `All`; keep the `CustomDescriptors !== undefined` branch for
future binaryen versions that name the flag. Add a post-optimize validation
instantiation in tests so this class of breakage fails CI.

## Acceptance criteria

- `optimize: 3` binary instantiates in node (V8) and bun (JSC) for the repro
- An optimize round-trip test compares -O vs non-O runtime results

## Dupe check

#1173 (done) fixed the system-CLI path; #1580 (done) claims the npm-module
masking — this is its silent failure, untracked.

## Resolution (2026-06-12)

`optimizeWithBinaryenModule` now builds the feature mask by **OR-ing only the
NAMED `Features` enum keys**, instead of starting from `Features.All`. On
binaryen 125 `All` = 0x3FFFFF but the OR of every named key = 0x1FFFFF — the
extra bit 0x200000 is the unnamed custom-descriptors flag, and
`Features.CustomDescriptors` is `undefined` so the old
`CustomDescriptors !== undefined` guard no-opped. OR-ing named keys excludes the
bit structurally; the guard is kept (defensively) for a future binaryen that
names the flag.

The named superset is the same one the non-`All` fallback branch already used,
extended with the other named keys binaryen 125 exposes (GCNNLocals, RelaxedSIMD,
ExtendedConst, SIMD128, Atomics, MultiMemory, CallIndirectOverlong) so nothing
js2wasm emits is disabled. Verified the optimizer still shrinks output (e.g. the
closure repro 2050 → 1300 bytes) and produces identical runtime results.

### Note on current reproducibility

On binaryen 125 the *symptom* (exact types in the output) no longer manifested
for the repro programs even before this change — binaryen's GC passes only
emit `(ref (exact $T))` under conditions that didn't trigger here — but the
**latent hazard** the issue describes was real: the mask still carried the
unnamed custom-descriptors bit, one binaryen-pass change away from re-emitting
exact types. This makes the mask correct by construction and adds the
post-optimize validation gate the issue asked for.

### Files

- `src/optimize.ts` — `optimizeWithBinaryenModule` feature mask
- `tests/issue-1973.test.ts` — for closures/arrays/classes: optimized binary
  passes `WebAssembly.validate`, contains no `exact` ref types (re-parsed via
  binaryen), and round-trips to the same observable output as unoptimized.

## Test Results

`tests/issue-1973.test.ts` (3 cases) green. Existing optimize suites
(`optimize-differential`, `wasm-opt-optimize`, `issue-1580`) green.
(`tail-call-optimization.test.ts` has a pre-existing `string_constants` import
failure on clean main, unrelated to this change.)
