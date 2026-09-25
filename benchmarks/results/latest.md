# js2wasm Benchmark Results

Date: 2026-09-25
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.050ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.146ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.426ms | 8.35ms | 2.93ms | FAILED | js |
| string/replace | 0.101ms | 0.716ms | 0.329ms | FAILED | js |
| string/case-convert | 0.057ms | 0.572ms | 0.269ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.89ms | 2.93ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.81ms | 2.99ms | 0.561ms | js |
| array/push-pop | 1.43ms | 0.510ms | 0.510ms | FAILED | gc-native |
| array/sort-i32 | 0.805ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.515ms | 0.510ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.056ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.263ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.161ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.220ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.123ms | — | — | js |
| dom/modify-text | 0.030ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.479ms | 8.90ms | 0.632ms | FAILED | js |
| mixed/text-search | 0.392ms | 5.19ms | 2.80ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 71.70ms | 72.85ms | 0.722ms | js |
| mixed/sieve | 1.55ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.50 | 5.02 | 4.52 | — |
| string/concat-long | 1000 | 3.60 | 4.61 | 3.86 | — |
| string/indexOf | 1000 | 19.20 | 63.70 | 12.20 | 14.85 |
| string/includes | 1000 | 19.26 | 145.98 | 14.92 | 15.61 |
| string/split | 10000 | 42.59 | 834.63 | 293.38 | — |
| string/replace | 1000 | 101.02 | 715.88 | 328.78 | — |
| string/case-convert | 2000 | 28.35 | 285.83 | 134.71 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.97 | 389.19 | 292.55 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 140.69 | 149.39 | 28.03 |
| array/map-filter | 30000 | 4.64 | 2.37 | 2.37 | — |
| array/indexOf | 1000 | 3959.56 | 2643.78 | 2640.25 | — |
| dom/create-elements | 2000 | 17.87 | 80.58 | — | — |
| dom/set-attributes | 6000 | 17.44 | 36.60 | — | — |
| dom/read-attributes | 3000 | 18.91 | 40.84 | — | — |
| dom/modify-text | 2000 | 14.98 | 53.06 | — | — |
| mixed/csv-parse | 11000 | 43.58 | 808.82 | 57.43 | — |
| mixed/text-search | 40000 | 9.79 | 129.68 | 69.89 | 26.98 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.32 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 573.60 | 582.83 | 5.78 |
| mixed/sieve | 200000 | 7.75 | 10.62 | 10.55 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.29x slower | — |
| string/concat-long | 1.28x slower | 1.07x slower | — |
| string/indexOf | 3.32x slower | 1.57x faster | 1.29x faster |
| string/includes | 7.58x slower | 1.29x faster | 1.23x faster |
| string/split | 19.60x slower | 6.89x slower | — |
| string/replace | 7.09x slower | 3.25x slower | — |
| string/case-convert | 10.08x slower | 4.75x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 22.93x slower | 17.24x slower | — |
| string/startsWith-endsWith | 7.02x slower | 7.45x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.81x faster | — |
| array/sort-i32 | 2.75x faster | 2.75x faster | — |
| array/map-filter | 1.96x faster | 1.96x faster | — |
| array/reduce | 4.18x faster | 4.22x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.02x faster | 2.02x faster | — |
| array/find | 15.99x faster | 16.15x faster | 4.09x slower |
| dom/create-elements | 4.51x slower | — | — |
| dom/set-attributes | 2.10x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.54x slower | — | — |
| mixed/csv-parse | 18.56x slower | 1.32x slower | — |
| mixed/text-search | 13.25x slower | 7.14x slower | 2.76x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 451.86x slower | 459.13x slower | 4.55x slower |
| mixed/sieve | 1.37x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.19x faster |
| string/indexOf | 5.22x faster |
| string/includes | 9.79x faster |
| string/split | 2.84x faster |
| string/replace | 2.18x faster |
| string/case-convert | 2.12x faster |
| string/substring | 1.21x faster |
| string/trim | 1.33x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.08x faster |
| mixed/text-search | 1.86x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x faster |

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
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1212.5ms | 655.5ms | — |
| string/concat-long | 441.3ms | 689.8ms | — |
| string/indexOf | 383.7ms | 662.3ms | 572.0ms |
| string/includes | 384.6ms | 695.2ms | 566.1ms |
| string/split | 533.2ms | 736.1ms | — |
| string/replace | 515.0ms | 786.8ms | — |
| string/case-convert | 526.1ms | 632.2ms | — |
| string/substring | 380.6ms | 492.4ms | — |
| string/trim | 476.6ms | 688.3ms | — |
| string/startsWith-endsWith | 498.6ms | 676.4ms | 613.0ms |
| array/push-pop | 524.6ms | 618.8ms | — |
| array/sort-i32 | 696.5ms | 707.9ms | — |
| array/map-filter | 656.7ms | 763.8ms | — |
| array/reduce | 594.6ms | 704.3ms | — |
| array/indexOf | 586.5ms | 691.7ms | — |
| array/slice | 510.9ms | 614.3ms | — |
| array/reverse | 516.0ms | 560.8ms | — |
| array/forEach | 658.1ms | 744.5ms | — |
| array/find | 491.1ms | 593.3ms | 549.4ms |
| dom/create-elements | 427.8ms | — | — |
| dom/set-attributes | 383.0ms | — | — |
| dom/read-attributes | 380.5ms | — | — |
| dom/modify-text | 380.1ms | — | — |
| mixed/csv-parse | 509.2ms | 671.6ms | — |
| mixed/text-search | 504.2ms | 680.9ms | 625.2ms |
| mixed/fibonacci | 450.7ms | 507.8ms | 472.3ms |
| mixed/matrix-multiply | 666.2ms | 694.5ms | 526.2ms |
| mixed/sieve | 600.8ms | 682.0ms | — |
