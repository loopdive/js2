# js2wasm Benchmark Results

Date: 2026-10-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.058ms | 0.056ms | 0.068ms | FAILED | host-call |
| string/concat-long | 0.005ms | 0.006ms | 0.007ms | FAILED | js |
| string/indexOf | 0.017ms | 0.068ms | 0.011ms | 0.030ms | gc-native |
| string/includes | 0.016ms | 0.100ms | 0.015ms | 0.015ms | linear-memory |
| string/split | 0.364ms | 6.98ms | 2.49ms | FAILED | js |
| string/replace | 0.100ms | 0.533ms | 0.295ms | FAILED | js |
| string/case-convert | 0.051ms | 0.496ms | 0.236ms | FAILED | js |
| string/substring | 0.108ms | 0.038ms | 0.032ms | FAILED | gc-native |
| string/trim | 0.158ms | 3.38ms | 2.52ms | FAILED | js |
| string/startsWith-endsWith | 0.479ms | 2.67ms | 2.74ms | 0.563ms | js |
| array/push-pop | 1.49ms | 0.493ms | 0.497ms | FAILED | host-call |
| array/sort-i32 | 0.651ms | 0.341ms | 0.340ms | FAILED | gc-native |
| array/map-filter | 0.143ms | 0.082ms | 0.082ms | FAILED | gc-native |
| array/reduce | 2.13ms | 0.488ms | 0.492ms | FAILED | host-call |
| array/indexOf | 5.39ms | 2.66ms | 2.65ms | FAILED | gc-native |
| array/slice | 0.046ms | 0.042ms | 0.042ms | FAILED | host-call |
| array/reverse | 8.38ms | 3.78ms | 3.78ms | FAILED | host-call |
| array/forEach | 0.061ms | 0.025ms | 0.025ms | FAILED | gc-native |
| array/find | 0.294ms | 0.017ms | 0.017ms | 0.996ms | gc-native |
| dom/create-elements | 0.065ms | 0.162ms | — | — | js |
| dom/set-attributes | 0.131ms | 0.195ms | — | — | js |
| dom/read-attributes | 0.071ms | 0.117ms | — | — | js |
| dom/modify-text | 0.061ms | 0.133ms | — | — | js |
| mixed/csv-parse | 0.412ms | 7.67ms | 0.577ms | FAILED | js |
| mixed/text-search | 0.440ms | 4.11ms | 2.67ms | 1.17ms | js |
| mixed/fibonacci | 0.136ms | 0.216ms | 0.216ms | 0.216ms | js |
| mixed/matrix-multiply | 0.189ms | 64.16ms | 66.65ms | 0.723ms | js |
| mixed/sieve | 1.68ms | 2.46ms | 2.45ms | FAILED | js |

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
| string/concat-short | 10000 | 5.76 | 5.59 | 6.80 | — |
| string/concat-long | 1000 | 5.42 | 5.71 | 6.52 | — |
| string/indexOf | 1000 | 16.59 | 68.02 | 11.49 | 29.83 |
| string/includes | 1000 | 16.45 | 100.22 | 14.94 | 14.59 |
| string/split | 10000 | 36.38 | 697.72 | 249.04 | — |
| string/replace | 1000 | 99.53 | 532.54 | 294.61 | — |
| string/case-convert | 2000 | 25.34 | 248.10 | 117.93 | — |
| string/substring | 10000 | 10.76 | 3.81 | 3.25 | — |
| string/trim | 10000 | 15.78 | 337.73 | 251.64 | — |
| string/startsWith-endsWith | 20000 | 23.93 | 133.70 | 137.20 | 28.16 |
| array/map-filter | 30000 | 4.76 | 2.73 | 2.73 | — |
| array/indexOf | 1000 | 5391.38 | 2660.22 | 2652.32 | — |
| dom/create-elements | 2000 | 32.72 | 81.23 | — | — |
| dom/set-attributes | 6000 | 21.84 | 32.46 | — | — |
| dom/read-attributes | 3000 | 23.83 | 39.05 | — | — |
| dom/modify-text | 2000 | 30.48 | 66.25 | — | — |
| mixed/csv-parse | 11000 | 37.44 | 697.18 | 52.48 | — |
| mixed/text-search | 40000 | 11.00 | 102.66 | 66.67 | 29.27 |
| mixed/fibonacci | 10000 | 13.56 | 21.62 | 21.58 | 21.56 |
| mixed/matrix-multiply | 125000 | 1.51 | 513.27 | 533.21 | 5.79 |
| mixed/sieve | 200000 | 8.41 | 12.29 | 12.24 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x faster | 1.18x slower | — |
| string/concat-long | 1.05x slower | 1.20x slower | — |
| string/indexOf | 4.10x slower | 1.44x faster | 1.80x slower |
| string/includes | 6.09x slower | 1.10x faster | 1.13x faster |
| string/split | 19.18x slower | 6.84x slower | — |
| string/replace | 5.35x slower | 2.96x slower | — |
| string/case-convert | 9.79x slower | 4.65x slower | — |
| string/substring | 2.83x faster | 3.31x faster | — |
| string/trim | 21.40x slower | 15.94x slower | — |
| string/startsWith-endsWith | 5.59x slower | 5.73x slower | 1.18x slower |
| array/push-pop | 3.02x faster | 3.00x faster | — |
| array/sort-i32 | 1.91x faster | 1.91x faster | — |
| array/map-filter | 1.74x faster | 1.75x faster | — |
| array/reduce | 4.36x faster | 4.33x faster | — |
| array/indexOf | 2.03x faster | 2.03x faster | — |
| array/slice | 1.08x faster | 1.08x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.42x faster | 2.42x faster | — |
| array/find | 17.59x faster | 17.60x faster | 3.38x slower |
| dom/create-elements | 2.48x slower | — | — |
| dom/set-attributes | 1.49x slower | — | — |
| dom/read-attributes | 1.64x slower | — | — |
| dom/modify-text | 2.17x slower | — | — |
| mixed/csv-parse | 18.62x slower | 1.40x slower | — |
| mixed/text-search | 9.33x slower | 6.06x slower | 2.66x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.59x slower |
| mixed/matrix-multiply | 339.26x slower | 352.44x slower | 3.82x slower |
| mixed/sieve | 1.46x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x slower |
| string/concat-long | 1.14x slower |
| string/indexOf | 5.92x faster |
| string/includes | 6.71x faster |
| string/split | 2.80x faster |
| string/replace | 1.81x faster |
| string/case-convert | 2.10x faster |
| string/substring | 1.17x faster |
| string/trim | 1.34x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.29x faster |
| mixed/text-search | 1.54x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1093.4ms | 626.3ms | — |
| string/concat-long | 452.9ms | 677.8ms | — |
| string/indexOf | 391.3ms | 686.4ms | 565.8ms |
| string/includes | 389.4ms | 702.4ms | 552.3ms |
| string/split | 531.4ms | 708.2ms | — |
| string/replace | 531.5ms | 783.2ms | — |
| string/case-convert | 522.3ms | 600.3ms | — |
| string/substring | 404.2ms | 497.0ms | — |
| string/trim | 494.9ms | 688.2ms | — |
| string/startsWith-endsWith | 528.3ms | 687.3ms | 644.7ms |
| array/push-pop | 529.9ms | 594.9ms | — |
| array/sort-i32 | 662.0ms | 747.6ms | — |
| array/map-filter | 708.2ms | 744.6ms | — |
| array/reduce | 636.1ms | 746.6ms | — |
| array/indexOf | 596.3ms | 690.4ms | — |
| array/slice | 525.6ms | 602.4ms | — |
| array/reverse | 501.0ms | 599.9ms | — |
| array/forEach | 664.8ms | 733.0ms | — |
| array/find | 521.9ms | 593.3ms | 549.3ms |
| dom/create-elements | 420.8ms | — | — |
| dom/set-attributes | 391.2ms | — | — |
| dom/read-attributes | 381.3ms | — | — |
| dom/modify-text | 379.7ms | — | — |
| mixed/csv-parse | 528.6ms | 683.0ms | — |
| mixed/text-search | 509.9ms | 719.6ms | 635.8ms |
| mixed/fibonacci | 466.1ms | 500.8ms | 475.9ms |
| mixed/matrix-multiply | 665.4ms | 715.3ms | 526.7ms |
| mixed/sieve | 633.6ms | 696.1ms | — |
