# js2wasm Benchmark Results

Date: 2026-10-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.138ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.412ms | 8.40ms | 2.81ms | FAILED | js |
| string/replace | 0.106ms | 0.811ms | 0.330ms | FAILED | js |
| string/case-convert | 0.056ms | 0.572ms | 0.266ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.94ms | 2.88ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.90ms | 2.93ms | 0.560ms | js |
| array/push-pop | 1.43ms | 0.506ms | 0.510ms | FAILED | host-call |
| array/sort-i32 | 0.791ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.071ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.512ms | 0.510ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.036ms | 0.093ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.133ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.99ms | 0.630ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.39ms | 2.88ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.295ms | js |
| mixed/matrix-multiply | 0.159ms | 75.30ms | 78.99ms | 0.723ms | js |
| mixed/sieve | 1.60ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.34 | 4.92 | 4.43 | — |
| string/concat-long | 1000 | 3.58 | 4.59 | 3.70 | — |
| string/indexOf | 1000 | 19.17 | 63.89 | 12.34 | 14.59 |
| string/includes | 1000 | 19.22 | 137.95 | 14.50 | 15.38 |
| string/split | 10000 | 41.16 | 840.02 | 280.55 | — |
| string/replace | 1000 | 105.61 | 811.00 | 330.48 | — |
| string/case-convert | 2000 | 27.76 | 285.96 | 133.03 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 393.74 | 287.59 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 144.79 | 146.36 | 28.01 |
| array/map-filter | 30000 | 4.29 | 2.37 | 2.39 | — |
| array/indexOf | 1000 | 3950.46 | 2646.98 | 2643.41 | — |
| dom/create-elements | 2000 | 17.89 | 46.67 | — | — |
| dom/set-attributes | 6000 | 17.47 | 36.10 | — | — |
| dom/read-attributes | 3000 | 18.48 | 44.34 | — | — |
| dom/modify-text | 2000 | 14.63 | 53.53 | — | — |
| mixed/csv-parse | 11000 | 44.21 | 817.16 | 57.29 | — |
| mixed/text-search | 40000 | 9.76 | 134.75 | 72.05 | 27.23 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.33 | 29.50 |
| mixed/matrix-multiply | 125000 | 1.27 | 602.42 | 631.91 | 5.78 |
| mixed/sieve | 200000 | 7.99 | 10.60 | 10.57 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.33x slower | — |
| string/concat-long | 1.28x slower | 1.03x slower | — |
| string/indexOf | 3.33x slower | 1.55x faster | 1.31x faster |
| string/includes | 7.18x slower | 1.33x faster | 1.25x faster |
| string/split | 20.41x slower | 6.82x slower | — |
| string/replace | 7.68x slower | 3.13x slower | — |
| string/case-convert | 10.30x slower | 4.79x slower | — |
| string/substring | 2.64x faster | 3.22x faster | — |
| string/trim | 23.16x slower | 16.91x slower | — |
| string/startsWith-endsWith | 7.22x slower | 7.30x slower | 1.40x slower |
| array/push-pop | 2.83x faster | 2.80x faster | — |
| array/sort-i32 | 2.69x faster | 2.70x faster | — |
| array/map-filter | 1.81x faster | 1.79x faster | — |
| array/reduce | 4.22x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.09x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.74x faster | — |
| array/find | 16.14x faster | 15.96x faster | 4.24x slower |
| dom/create-elements | 2.61x slower | — | — |
| dom/set-attributes | 2.07x slower | — | — |
| dom/read-attributes | 2.40x slower | — | — |
| dom/modify-text | 3.66x slower | — | — |
| mixed/csv-parse | 18.48x slower | 1.30x slower | — |
| mixed/text-search | 13.81x slower | 7.38x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.45x slower |
| mixed/matrix-multiply | 472.95x slower | 496.10x slower | 4.54x slower |
| mixed/sieve | 1.33x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.18x faster |
| string/includes | 9.52x faster |
| string/split | 2.99x faster |
| string/replace | 2.45x faster |
| string/case-convert | 2.15x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.26x faster |
| mixed/text-search | 1.87x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.05x slower |
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
| string/concat-short | 1142.3ms | 592.1ms | — |
| string/concat-long | 429.3ms | 635.4ms | — |
| string/indexOf | 370.0ms | 659.1ms | 535.1ms |
| string/includes | 365.3ms | 659.5ms | 555.3ms |
| string/split | 497.6ms | 676.0ms | — |
| string/replace | 550.7ms | 783.3ms | — |
| string/case-convert | 495.4ms | 604.9ms | — |
| string/substring | 391.1ms | 471.7ms | — |
| string/trim | 471.6ms | 688.2ms | — |
| string/startsWith-endsWith | 478.9ms | 693.3ms | 612.9ms |
| array/push-pop | 503.8ms | 609.5ms | — |
| array/sort-i32 | 678.8ms | 718.2ms | — |
| array/map-filter | 678.7ms | 756.0ms | — |
| array/reduce | 628.6ms | 693.8ms | — |
| array/indexOf | 597.7ms | 652.5ms | — |
| array/slice | 502.6ms | 575.7ms | — |
| array/reverse | 493.4ms | 586.3ms | — |
| array/forEach | 634.1ms | 708.0ms | — |
| array/find | 501.0ms | 588.7ms | 537.0ms |
| dom/create-elements | 419.1ms | — | — |
| dom/set-attributes | 382.9ms | — | — |
| dom/read-attributes | 382.5ms | — | — |
| dom/modify-text | 364.3ms | — | — |
| mixed/csv-parse | 519.0ms | 665.9ms | — |
| mixed/text-search | 508.9ms | 692.2ms | 612.2ms |
| mixed/fibonacci | 444.4ms | 491.5ms | 478.5ms |
| mixed/matrix-multiply | 639.1ms | 687.8ms | 521.9ms |
| mixed/sieve | 606.4ms | 680.0ms | — |
