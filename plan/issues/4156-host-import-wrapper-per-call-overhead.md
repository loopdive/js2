---
id: 4156
title: "perf: the host-import wrapper allocated a rest-args array on every call — and the wasm→JS crossing, not the wrapper, is what makes the host-call lane 4–14x slower than js"
status: done
created: 2026-08-04
updated: 2026-08-18
completed: 2026-08-04
priority: medium
feasibility: easy
reasoning_effort: high
task_type: performance
area: runtime
language_feature: n/a
goal: performance
sprint: 78
horizon: s
es_edition: n/a
related: [3898, 3922, 3924]
loc-budget-allow:
  - src/runtime.ts
---

# #4156 — host-import wrapper overhead, and where the host-call gap actually lives

## Status: done — small fix landed; the large finding is that the wrapper was never the main cost

## What was changed

Every host import in a compiled module passes through a single wrapper in
`buildImports` (recursion-depth guard + exception capture for `catch_all`). It
collected `...args` and called `.apply`, so **every** host call — string method,
DOM operation, coercion — allocated a fresh array.

Replaced with a switch on `arguments.length` dispatching to a direct `.call`
for 0–4 arguments, falling back to `.apply(this, arguments)` beyond that.

Interleaved wasm-side A/B, 200 samples × 2 rounds, 1000
`String.prototype.includes` calls per sample, alternating runtimes by file copy
(**not** `git stash` — shared-stack hazard):

| wrapper | median ns/op |
| --- | --- |
| `...args` + `.apply` | 66.2 / 69.5 |
| `switch` → `.call` | 64.9 / 65.4 |

**~4%**, both rounds favouring the new shape, and noticeably steadier
(round-to-round spread 4.6 → 0.5 ns).

## Trap 1 — the obvious measurement is the wrong one

A JS→JS microbenchmark of the two wrapper shapes reports **57.9 → 34.0 ns/op,
a 41% cut**. That number was nearly shipped as the headline. It does not
transfer: host imports are called **from wasm**, and V8's wasm→JS entry already
materialises the argument list, so most of the rest-parameter saving never
appears. The honest figure is ~4%.

The lesson generalises past this change: when optimising a wrapper, benchmark it
on the call path it actually sits on, not the one that is convenient to set up.

## Trap 2 — arity specialisation must key off arguments RECEIVED

The tempting version of this fix builds a fixed-arity wrapper from
`original.length`. That is **unsound here**: `length` is 0 for a variadic or
defaulted callee, so such a wrapper would declare zero parameters and silently
drop every argument. Several resolved imports are variadic.

Keying the switch off `arguments.length` forwards exactly what was received,
whatever the callee's declared arity. Verified against a variadic callee
(`length === 0`) for 0, 1, 2, 3, 4, 5 and 7 arguments — the callee observed
exactly what was passed in every case.

## The larger finding — the wrapper was never the main cost

Decomposing `string/includes` in the host-call lane (1000 ops per call):

| component | ns/op |
| --- | --- |
| full loop, wasm host-call lane | ~65 |
| the same `includes` work in raw JS | 17.5 |
| inline `h.includes(...)`, no call at all | 18.3 |
| js reference (whole benchmark) | 17.0 |
| loop + arithmetic only, no host call | 7.1 |

So of ~65 ns/op, only **~17 ns is the actual work** — the remaining **~48 ns is
the wasm→JS crossing itself**. No wrapper change reaches that.

A second measurement rules out a plausible alternative culprit: removing the
`(i * 61) % 10011` argument arithmetic (which lowers to an f64 modulo **helper
call**, since wasm has no f64 remainder instruction) changes the total by only
**2.5 ns/op** (69.0 → 66.5). The f64 modulo helper is nearly free here and is
not worth pursuing for this benchmark, despite looking suspicious in the WAT.

**Consequence:** the host-call lane cannot be brought near parity by making the
boundary cheaper. It has to stop crossing the boundary per operation. That is
exactly why the gc-native lane — which lowers these operations to native WasmGC
kernels and never leaves wasm — runs the same benchmarks at ~1.1x:

| benchmark | host-call | gc-native |
| --- | --- | --- |
| `string/split` | 13.8x | 1.09x |
| `string/includes` | 8.1x | 1.08x |
| `string/trim` | 5.4x | 1.45x |
| `string/indexOf` | 4.1x | 1.09x |

The same crossing cost explains the DOM benchmarks sitting at ~3.1–3.5x, since
those are *nothing but* host calls.

## Follow-up worth its own issue

Closing the host-call gap properly means one of:

1. **Native kernels over host strings** — materialise once, scan in wasm. Only
   pays off when the per-call crossing exceeds the copy, so it needs a
   length threshold and a way to cache the materialised form across calls.
2. **Keep strings native in more configurations** — i.e. widen where the
   gc-native representation is used, which is the direction #3912 was already
   pushing on the number→string side.

Both are codegen-scale changes and neither is attempted here. Recorded so the
~4% wrapper fix is not mistaken for having addressed the 4–14x gap.

## Acceptance criteria

1. ✅ The rest-args allocation is gone from the host-import path.
2. ✅ Forwarding is exact for variadic and defaulted callees, verified across
   0–7 arguments.
3. ✅ No new test failures: `tests/equivalence/spec` and
   `dom-extern-class` show only the 8 pre-existing `coercion/arithmetic-add`
   failures, which reproduce **identically on the base runtime** (8 failed / 12
   passed either way). `tests/playground-full.test.ts` fails to collect because
   `playground/` does not exist in this checkout — environmental.
4. ✅ The measured effect is reported as ~4%, not as the misleading 41%.

## Note on the LOC budget

`src/runtime.ts` is a god-file sitting exactly at its ceiling (16352), so any
growth trips `check:loc-budget`. The comment was trimmed to the two traps that
would otherwise be re-discovered the hard way; the switch itself is irreducibly
~12 lines. `loc-budget-allow` is granted in this issue's frontmatter for that
reason.

## Provenance

From a request to optimise the performance-page benchmarks. The measurement
groundwork — and the discovery that several of those benchmarks were not
measuring anything real — is #3898 and PR #4118.
