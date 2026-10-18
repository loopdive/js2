---
id: 7087
title: "Native-first string kernel is 20x slower than host-assisted in the S6 performance gate"
status: ready
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

## Working hypothesis, not yet a root-cause claim

The source is the counted append loop optimized by #1004:

```ts
let str = "";
for (let i = 0; i < 1000; i++) str = str + "abcde";
return str.length;
```

#1004 lowers the loop to one `repeat` plus one concat. The measured host row is
only ~60 ns, which strongly suggests the host-assisted provider and O4 pipeline
remove or precompute more of the `repeat/concat/length` chain than the native
string provider. That must be proven from the optimized Wasm/IR before choosing
between a compiler fix and a benchmark-validity fix; the timing alone does not
identify which stage owns the delta.

## Required investigation

1. Capture the pre- and post-`wasm-opt -O4` bodies for `bench_string` in both
   profiles and count the remaining repeat, concat, allocation and length work.
2. Prove whether both rows execute equivalent dynamic work. If host-assisted
   folds the fixed result to `5000`, determine whether native-first can apply
   the same legal fold. If the benchmark no longer measures string work in one
   profile, repair the benchmark and remeasure both profiles instead of
   optimizing toward an invalid control.
3. Check the #1004 counted-append transform and the native `__str_repeat` /
   concat / length lowering before changing generic string helpers.
4. Re-run the exact #5385 kernel commands on Node >=24 and update the audit
   evidence. Keep the npm package rows as controls so a microkernel win cannot
   hide an application regression.

## Acceptance criteria

- [ ] Optimized IR/Wasm proves the exact source of the profile delta; the issue
      records whether it is real runtime work or benchmark constant folding.
- [ ] The benchmark executes equivalent work in both profiles, or the compiler
      gives native-first the same semantics-preserving optimization.
- [ ] Native-first/host-assisted median runtime is <=2.0x in the repaired
      nine-round kernel harness on Node >=24.
- [ ] `bench_string()` still returns `5000` in JS, host-assisted and
      native-first profiles.
- [ ] The acorn, cookie, redux and hono native-first lanes remain measured with
      matching checksums; no package lane regresses to an error state.
- [ ] #5385 and its checked-in audit artifact carry the post-fix measurement.
