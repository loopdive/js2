---
id: 7087
title: "Native-first string kernel is 20x slower than host-assisted in the S6 performance gate"
status: done
created: 2026-10-18
updated: 2026-10-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler, codegen, performance, strings
language_feature: string-concat
goal: architecture
sprint: current
parent: 5385
horizon: s
es_edition: multi
related: [1004, 3898, 6708]
---
# #7087 — native-first string kernel profile delta

## Finding

The required #5385/#6708 performance run on `main` commit
`730b9841684187e1dc1d8295cbbbfc457aa16e05` (macOS arm64, Node 24.4.1,
V8 13.6.233.10-node.17) found one profile regression above S6's 2x blocker
threshold:

| profile | median Wasm runtime | stddev | median JS control |
| --- | ---: | ---: | ---: |
| host-assisted (`semanticProviders: "auto"`) | 0.05975 us | 0.00161 us | 2.23100 us |
| native-first | 1.21779 us | 0.01301 us | 2.09902 us |

Native-first is **20.38x slower than host-assisted** on
`examples/benchmarks/string.ts`. It is still about **1.72x faster than the
plain-JS control**, so this is not evidence that native string execution is
generally uncompetitive. It is a provider-specific optimization delta that
violates the explicit S6 gate.

This confirms the direction and scale of #5385's 2026-09-07 exploratory run,
which measured 0.163 us host-assisted versus 2.919 us native-first (17.90x).
The later run uses the hardened optimized-tier harness and a newer main commit;
the repeated profile delta is therefore not being attributed to timing noise.

The same run makes the scope narrow:

- fib, loop and array are within 1.01x of host-assisted;
- acorn, cookie, redux and hono all return the expected checksum and are
  9.97x–41.34x faster under native-first;
- both string rows use the same optimized, nine-round harness and verify the
  JS control's optimizing tier.

Full measurements and reproduction commands are in
`plan/audit/5385-native-first-perf-evidence-20261018.json`.

## Root cause — confirmed from optimized Wasm

The source is the counted append loop optimized by #1004:

```ts
let str = "";
for (let i = 0; i < 1000; i++) str = str + "abcde";
return str.length;
```

#1004 lowers the loop to one `repeat` plus one concat. Neither profile
constant-folded the function to `5000`:

- Host-assisted O4 still calls `env.string_repeat("abcde", 1000)`, then
  `wasm:js-string.concat` and `wasm:js-string.length`. V8 can retain the
  repeated value as a rope and answer its UTF-16 length without copying it.
- Native-first O4 still ran `__str_repeat`, concat and the native length-field
  read. The old native repeat kernel doubled its rope until it reached 5,120
  code units, then called `substring(0, 5000)`. Native substring flattened and
  copied the rope, so every benchmark invocation performed O(result length)
  work solely to discard the characters and read the stored length.

The inputs, result and observable string operations were therefore equivalent;
the 20.38x delta was real provider work, not measurement noise or a benchmark
that had ceased to execute on one side.

## Fix

`src/stdlib/strings.ts` now builds an exact-length rope by binary decomposition:
it halves the already-normalized integer count, doubles the current piece, and
appends only the set-bit pieces. The result has the requested length directly,
so no trailing substring or flatten/copy is needed. The algorithm remains
O(log count) in concat nodes and preserves the existing empty/count-zero arms.

This is deliberately a native semantic-core fix, not a boundary special case:

- the generic JS `repeat` adapter still owns `ToIntegerOrInfinity`, negative /
  infinity `RangeError`, empty-receiver handling and the result-size bound;
- the #1004 counted path still carries its authenticated exact-trip-count
  provenance and uses the same provider ABI;
- host-assisted `wasm:js-string`, JS value wrapping/unwrapping and live
  host-backed boundary objects are unchanged;
- no JS machinery was moved into native objects and no boundary value is copied
  merely to obtain this speedup.

`tests/issue-7087-native-string-repeat-kernel.test.ts` pins the exact-rope
shape (`f64.floor`, two concat sites, no substring call) and executes dynamic
counts 0, 1, 2, 3, 7, 32 and 1000. The existing #1004 and typed-repeat suites
continue to authenticate the prepared provider and error semantics.

## Post-fix evidence

Measured sequentially at implementation commit
`5b36f318c5e9a5b1a9e11da6b924d64f5be8d1b2` with the same macOS arm64,
Node 24.4.1 / V8 13.6.233.10-node.17, O4/TurboFan, two warmups and nine measured
rounds:

| kernel | host-assisted | native-first | native / host | verdict |
| --- | ---: | ---: | ---: | --- |
| fib | 2347.651 us | 2340.268 us | 0.997x | pass |
| loop | 86.057 us | 85.413 us | 0.993x | pass |
| string | 0.06365 us | 0.09078 us | **1.426x** | **pass** |
| array | 10.5734 us | 10.5358 us | 0.996x | pass |

The string result remains `5000`; native-first is now ~25.6x faster than its
plain-JS control (0.09078 us versus 2.32584 us) and below #6708's 2.0x blocker
threshold. The other kernels are unchanged within run variance.

The four native-first npm controls were recompiled and remeasured from the same
commit. Each requested and verified O4 and matched its native-oracle checksum:

| workload | native-first | checksum | versus recorded host |
| --- | ---: | ---: | ---: |
| acorn | 67,060.692 us | 422 / 422 | 27.24x faster |
| cookie | 19.651 us | 1 / 1 | 9.09x faster |
| redux | 2.068 us | 7 / 7 | 18.18x faster |
| hono | 2.703 us | 9 / 9 | 36.53x faster |

Exact values, commands and environment are appended to
`plan/audit/5385-native-first-perf-evidence-20261018.json`.

## Acceptance criteria

- [x] Optimized IR/Wasm proves the exact source of the profile delta; the issue
      records whether it is real runtime work or benchmark constant folding.
- [x] The benchmark executes equivalent work in both profiles, or the compiler
      gives native-first the same semantics-preserving optimization.
- [x] Native-first/host-assisted median runtime is <=2.0x in the repaired
      nine-round kernel harness on Node >=24.
- [x] `bench_string()` still returns `5000` in JS, host-assisted and
      native-first profiles.
- [x] The acorn, cookie, redux and hono native-first lanes remain measured with
      matching checksums; no package lane regresses to an error state.
- [x] #5385 and its checked-in audit artifact carry the post-fix measurement.
