---
id: 3363
title: "standalone: Array.prototype.flat() has no native arm — depth-1 homogeneous nested-array flatten (child of #2717 follow-up / #3180)"
status: done
assignee: ttraenkler/dev-j
sprint: current
created: 2026-07-17
completed: 2026-07-17
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: array-methods
goal: standalone
related: [2717, 3180, 2860, 1136]
origin: "#3180 umbrella verify-first probe (dev-j, 2026-07-17): flat() hard-CEs standalone; #2717 only added the fail-loud refusal and explicitly deferred 'a native recursive-flatten arm' as a separate follow-up."
loc-budget-allow:
  - src/codegen/array-methods.ts
---

# #3363 — standalone-native `Array.prototype.flat()` (depth-1 homogeneous)

## Problem (verified, current upstream/main)

Under `--target standalone`/`wasi`, `Array.prototype.flat()` hard-CEs:

```
Codegen error: Array.prototype.flat() is not yet supported in --target
standalone/wasi (#2717) — there is no Wasm-native flatten arm …
```

`#2717` (`status: done`, sprint 67) only landed the **fail-loud refusal** —
it swapped the unsatisfiable `__array_flat` host import for a loud
`reportError` + `unreachable`, and its own code comment defers the real fix:
"A native recursive-flatten arm (depth + runtime IsArray + dynamic
result-build over heterogeneous WasmGC element types) is a separate, larger
follow-up." This issue lands the **common, tractable slice** of that arm.

Verified on current main that the underlying nested-array representation is
fully usable standalone (`a[0][1]`, `a[i].length`, manual nested-loop flatten
all work) — so the only gap is the missing `flat()` codegen arm.

This is bucket-adjacent to the #3180 standalone Array residual umbrella (parent
#2860 standalone-vs-host gap); it is NOT one of #3180's six HOF buckets (those
are peer-owned #2992/bucket-1, dev-f #3359/bucket-5, or hard edge cases), so it
does not collide with in-flight work.

## Scope (single slice — deliberately narrow)

Native arm for the **default depth (1)** flatten of a **statically-typed
homogeneous** nested array `T[][]` (the outer array's element type resolves to
a ref to an inner scalar vec, `T ∈ {number(f64/i32)}` and the WasmGC vec shape).
Emits a two-pass flatten:

1. Sum the (non-null) inner lengths → total.
2. Allocate a fresh result data array of the inner element kind, size `total`.
3. `array.copy` each inner vec's elements contiguously into the result.
4. Return a fresh `$vec` struct `{ total, resultData }` of the inner vec type.

**Out of scope (keeps the existing loud refusal):** an explicit `depth`
argument (any value, including a literal ≠ 1), heterogeneous / mixed
array-and-scalar element unions, deeper-than-1 recursion, and non-nested-vec
receivers. Host/gc mode is unchanged (keeps the `__array_flat` delegation).
`flatMap` remains deferred (#2717).

## Spec

ES2024 §23.1.3.13 `Array.prototype.flat([depth])` — with `depth` defaulting to
1, `FlattenIntoArray` copies each element of a sub-array (an element for which
`IsArray` is true) into the result in order; a depth-1 flatten of an array whose
elements are all arrays is a straight concatenation of the sub-arrays.

## Acceptance

- `[[1,2],[3]].flat()` compiles + runs standalone → `[1,2,3]` (length 3,
  elements correct), zero host imports.
- Empty inner arrays contribute nothing; an empty outer array flattens to empty.
- An explicit depth argument or non-nested receiver still refuses loudly (no
  silent wrong value).
- Host-lane byte-identity; no test262 regression.
