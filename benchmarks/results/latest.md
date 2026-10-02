# js2wasm Benchmark Results

Date: 2026-10-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.056ms | 0.059ms | 0.068ms | FAILED | js |
| string/concat-long | 0.006ms | 0.006ms | 0.007ms | FAILED | js |
| string/indexOf | 0.016ms | 0.053ms | 0.012ms | 0.033ms | gc-native |
| string/includes | 0.017ms | 0.108ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.356ms | 7.00ms | 2.59ms | FAILED | js |
| string/replace | 0.101ms | 0.543ms | 0.306ms | FAILED | js |
| string/case-convert | 0.053ms | 0.495ms | 0.246ms | FAILED | js |
| string/substring | 0.119ms | 0.038ms | 0.033ms | FAILED | gc-native |
| string/trim | 0.162ms | 3.32ms | 2.57ms | FAILED | js |
| string/startsWith-endsWith | 0.483ms | 2.75ms | 2.78ms | 0.569ms | js |
| array/push-pop | 1.52ms | 0.502ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.650ms | 0.341ms | 0.341ms | FAILED | host-call |
| array/map-filter | 0.144ms | 0.083ms | 0.083ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.495ms | 0.493ms | FAILED | gc-native |
| array/indexOf | 5.47ms | 2.67ms | 2.66ms | FAILED | gc-native |
| array/slice | 0.047ms | 0.044ms | 0.044ms | FAILED | host-call |
| array/reverse | 8.46ms | 3.81ms | 3.81ms | FAILED | host-call |
| array/forEach | 0.093ms | 0.025ms | 0.026ms | FAILED | host-call |
| array/find | 0.294ms | 0.017ms | 0.017ms | 0.988ms | host-call |
| dom/create-elements | 0.067ms | 0.102ms | — | — | js |
| dom/set-attributes | 0.135ms | 0.193ms | — | — | js |
| dom/read-attributes | 0.074ms | 0.117ms | — | — | js |
| dom/modify-text | 0.067ms | 0.108ms | — | — | js |
| mixed/csv-parse | 1.06ms | 7.11ms | 0.583ms | FAILED | gc-native |
| mixed/text-search | 0.445ms | 4.22ms | 2.59ms | 1.17ms | js |
| mixed/fibonacci | 0.135ms | 0.217ms | 0.217ms | 0.219ms | js |
| mixed/matrix-multiply | 0.189ms | 62.81ms | 65.88ms | 0.727ms | js |
| mixed/sieve | 1.69ms | 2.46ms | 2.47ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 5.56 | 5.85 | 6.76 | — |
| string/concat-long | 1000 | 5.64 | 6.04 | 6.98 | — |
| string/indexOf | 1000 | 16.40 | 53.13 | 11.52 | 32.93 |
| string/includes | 1000 | 16.79 | 107.86 | 14.45 | 16.60 |
| string/split | 10000 | 35.56 | 700.38 | 258.66 | — |
| string/replace | 1000 | 101.31 | 543.09 | 306.27 | — |
| string/case-convert | 2000 | 26.44 | 247.59 | 122.88 | — |
| string/substring | 10000 | 11.91 | 3.81 | 3.26 | — |
| string/trim | 10000 | 16.19 | 331.53 | 256.61 | — |
| string/startsWith-endsWith | 20000 | 24.17 | 137.28 | 138.91 | 28.43 |
| array/map-filter | 30000 | 4.79 | 2.77 | 2.76 | — |
| array/indexOf | 1000 | 5473.53 | 2665.94 | 2661.28 | — |
| dom/create-elements | 2000 | 33.56 | 50.77 | — | — |
| dom/set-attributes | 6000 | 22.58 | 32.10 | — | — |
| dom/read-attributes | 3000 | 24.77 | 38.93 | — | — |
| dom/modify-text | 2000 | 33.27 | 54.22 | — | — |
| mixed/csv-parse | 11000 | 95.95 | 646.40 | 53.04 | — |
| mixed/text-search | 40000 | 11.14 | 105.50 | 64.63 | 29.14 |
| mixed/fibonacci | 10000 | 13.54 | 21.67 | 21.67 | 21.88 |
| mixed/matrix-multiply | 125000 | 1.51 | 502.45 | 527.02 | 5.81 |
| mixed/sieve | 200000 | 8.46 | 12.28 | 12.34 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.05x slower | 1.22x slower | — |
| string/concat-long | 1.07x slower | 1.24x slower | — |
| string/indexOf | 3.24x slower | 1.42x faster | 2.01x slower |
| string/includes | 6.43x slower | 1.16x faster | 1.01x faster |
| string/split | 19.70x slower | 7.27x slower | — |
| string/replace | 5.36x slower | 3.02x slower | — |
| string/case-convert | 9.36x slower | 4.65x slower | — |
| string/substring | 3.13x faster | 3.65x faster | — |
| string/trim | 20.48x slower | 15.85x slower | — |
| string/startsWith-endsWith | 5.68x slower | 5.75x slower | 1.18x slower |
| array/push-pop | 3.02x faster | 3.03x faster | — |
| array/sort-i32 | 1.91x faster | 1.91x faster | — |
| array/map-filter | 1.73x faster | 1.74x faster | — |
| array/reduce | 4.38x faster | 4.40x faster | — |
| array/indexOf | 2.05x faster | 2.06x faster | — |
| array/slice | 1.07x faster | 1.06x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.65x faster | 3.65x faster | — |
| array/find | 17.38x faster | 17.26x faster | 3.36x slower |
| dom/create-elements | 1.51x slower | — | — |
| dom/set-attributes | 1.42x slower | — | — |
| dom/read-attributes | 1.57x slower | — | — |
| dom/modify-text | 1.63x slower | — | — |
| mixed/csv-parse | 6.74x slower | 1.81x faster | — |
| mixed/text-search | 9.47x slower | 5.80x slower | 2.62x slower |
| mixed/fibonacci | 1.60x slower | 1.60x slower | 1.62x slower |
| mixed/matrix-multiply | 332.54x slower | 348.80x slower | 3.85x slower |
| mixed/sieve | 1.45x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x slower |
| string/concat-long | 1.16x slower |
| string/indexOf | 4.61x faster |
| string/includes | 7.46x faster |
| string/split | 2.71x faster |
| string/replace | 1.77x faster |
| string/case-convert | 2.01x faster |
| string/substring | 1.17x faster |
| string/trim | 1.29x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 12.19x faster |
| mixed/text-search | 1.63x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.05x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1124.4ms | 620.1ms | — |
| string/concat-long | 441.2ms | 656.0ms | — |
| string/indexOf | 381.9ms | 660.9ms | 566.3ms |
| string/includes | 390.0ms | 702.2ms | 550.6ms |
| string/split | 524.5ms | 694.8ms | — |
| string/replace | 519.4ms | 756.2ms | — |
| string/case-convert | 555.3ms | 609.7ms | — |
| string/substring | 417.3ms | 495.8ms | — |
| string/trim | 498.6ms | 710.8ms | — |
| string/startsWith-endsWith | 498.8ms | 724.2ms | 642.1ms |
| array/push-pop | 529.6ms | 587.2ms | — |
| array/sort-i32 | 671.6ms | 717.7ms | — |
| array/map-filter | 694.1ms | 779.9ms | — |
| array/reduce | 623.1ms | 713.8ms | — |
| array/indexOf | 628.6ms | 665.1ms | — |
| array/slice | 536.4ms | 612.0ms | — |
| array/reverse | 522.5ms | 608.9ms | — |
| array/forEach | 674.7ms | 741.8ms | — |
| array/find | 507.4ms | 611.9ms | 540.9ms |
| dom/create-elements | 433.2ms | — | — |
| dom/set-attributes | 395.0ms | — | — |
| dom/read-attributes | 400.1ms | — | — |
| dom/modify-text | 395.0ms | — | — |
| mixed/csv-parse | 528.9ms | 678.4ms | — |
| mixed/text-search | 520.7ms | 725.5ms | 651.2ms |
| mixed/fibonacci | 473.9ms | 503.5ms | 512.5ms |
| mixed/matrix-multiply | 654.2ms | 723.9ms | 526.6ms |
| mixed/sieve | 626.0ms | 697.4ms | — |
