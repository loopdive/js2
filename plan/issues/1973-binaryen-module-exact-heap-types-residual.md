---
id: 1973
title: "optimize:true via binaryen npm module re-introduces exact heap types — optimized binaries rejected by stock V8 and JSC (#1580 masking silently no-ops)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
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
