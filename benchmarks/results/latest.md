# js2wasm Benchmark Results

Date: 2026-09-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.046ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.018ms | gc-native |
| string/includes | 0.019ms | 0.121ms | 0.015ms | 0.018ms | gc-native |
| string/split | 0.426ms | 8.22ms | 2.94ms | FAILED | js |
| string/replace | 0.107ms | 0.679ms | 0.337ms | FAILED | js |
| string/case-convert | 0.058ms | 0.631ms | 0.277ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.01ms | 2.92ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 3.09ms | 2.96ms | 0.560ms | js |
| array/push-pop | 1.40ms | 0.498ms | 0.502ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.294ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.125ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.501ms | 0.500ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.015ms | 0.016ms | 0.996ms | host-call |
| dom/create-elements | 0.204ms | 0.096ms | — | — | host-call |
| dom/set-attributes | 0.105ms | 0.221ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.128ms | — | — | js |
| dom/modify-text | 0.030ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.487ms | 8.25ms | 0.637ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.15ms | 2.96ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.286ms | js |
| mixed/matrix-multiply | 0.157ms | 69.62ms | 72.53ms | 0.715ms | js |
| mixed/sieve | 1.55ms | 2.10ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.08 | 4.60 | 4.50 | — |
| string/concat-long | 1000 | 3.58 | 4.55 | 3.57 | — |
| string/indexOf | 1000 | 19.20 | 63.96 | 12.34 | 18.37 |
| string/includes | 1000 | 19.23 | 121.02 | 14.52 | 18.25 |
| string/split | 10000 | 42.61 | 821.92 | 294.17 | — |
| string/replace | 1000 | 106.51 | 679.40 | 337.42 | — |
| string/case-convert | 2000 | 28.95 | 315.57 | 138.42 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.01 | 401.25 | 291.86 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 154.72 | 147.86 | 28.01 |
| array/map-filter | 30000 | 4.18 | 2.33 | 2.33 | — |
| array/indexOf | 1000 | 3950.60 | 2643.55 | 2639.75 | — |
| dom/create-elements | 2000 | 102.13 | 47.95 | — | — |
| dom/set-attributes | 6000 | 17.44 | 36.82 | — | — |
| dom/read-attributes | 3000 | 18.29 | 42.80 | — | — |
| dom/modify-text | 2000 | 15.07 | 57.44 | — | — |
| mixed/csv-parse | 11000 | 44.28 | 750.24 | 57.89 | — |
| mixed/text-search | 40000 | 9.72 | 128.83 | 74.09 | 27.36 |
| mixed/fibonacci | 10000 | 12.18 | 28.31 | 28.31 | 28.62 |
| mixed/matrix-multiply | 125000 | 1.26 | 556.98 | 580.21 | 5.72 |
| mixed/sieve | 200000 | 7.74 | 10.51 | 10.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.46x slower | — |
| string/concat-long | 1.27x slower | 1.00x faster | — |
| string/indexOf | 3.33x slower | 1.56x faster | 1.05x faster |
| string/includes | 6.29x slower | 1.32x faster | 1.05x faster |
| string/split | 19.29x slower | 6.90x slower | — |
| string/replace | 6.38x slower | 3.17x slower | — |
| string/case-convert | 10.90x slower | 4.78x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 23.59x slower | 17.16x slower | — |
| string/startsWith-endsWith | 7.71x slower | 7.36x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.78x faster | — |
| array/sort-i32 | 2.69x faster | 2.70x faster | — |
| array/map-filter | 1.80x faster | 1.79x faster | — |
| array/reduce | 2.67x faster | 2.68x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 16.41x faster | 15.78x faster | 3.92x slower |
| dom/create-elements | 2.13x faster | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.34x slower | — | — |
| dom/modify-text | 3.81x slower | — | — |
| mixed/csv-parse | 16.94x slower | 1.31x slower | — |
| mixed/text-search | 13.25x slower | 7.62x slower | 2.81x slower |
| mixed/fibonacci | 2.33x slower | 2.32x slower | 2.35x slower |
| mixed/matrix-multiply | 443.33x slower | 461.83x slower | 4.55x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 5.18x faster |
| string/includes | 8.33x faster |
| string/split | 2.79x faster |
| string/replace | 2.01x faster |
| string/case-convert | 2.28x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.05x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.04x slower |
| mixed/csv-parse | 12.96x faster |
| mixed/text-search | 1.74x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
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
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1140.8ms | 603.7ms | — |
| string/concat-long | 423.1ms | 648.3ms | — |
| string/indexOf | 367.5ms | 652.4ms | 537.3ms |
| string/includes | 369.5ms | 655.3ms | 556.2ms |
| string/split | 513.2ms | 701.4ms | — |
| string/replace | 498.3ms | 722.8ms | — |
| string/case-convert | 514.0ms | 603.8ms | — |
| string/substring | 404.4ms | 448.4ms | — |
| string/trim | 487.3ms | 666.8ms | — |
| string/startsWith-endsWith | 505.1ms | 680.8ms | 608.1ms |
| array/push-pop | 511.0ms | 571.9ms | — |
| array/sort-i32 | 671.8ms | 703.6ms | — |
| array/map-filter | 686.7ms | 733.0ms | — |
| array/reduce | 604.5ms | 686.2ms | — |
| array/indexOf | 579.5ms | 678.2ms | — |
| array/slice | 504.1ms | 602.7ms | — |
| array/reverse | 498.7ms | 577.8ms | — |
| array/forEach | 669.2ms | 637.7ms | — |
| array/find | 476.8ms | 571.0ms | 525.4ms |
| dom/create-elements | 432.0ms | — | — |
| dom/set-attributes | 370.4ms | — | — |
| dom/read-attributes | 376.2ms | — | — |
| dom/modify-text | 363.2ms | — | — |
| mixed/csv-parse | 525.6ms | 679.9ms | — |
| mixed/text-search | 498.5ms | 691.6ms | 608.0ms |
| mixed/fibonacci | 448.7ms | 476.7ms | 474.5ms |
| mixed/matrix-multiply | 643.7ms | 724.3ms | 523.8ms |
| mixed/sieve | 588.6ms | 655.5ms | — |
