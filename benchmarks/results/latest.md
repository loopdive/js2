# js2wasm Benchmark Results

Date: 2026-09-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.056ms | 0.057ms | 0.067ms | FAILED | js |
| string/concat-long | 0.006ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.017ms | 0.053ms | 0.012ms | 0.035ms | gc-native |
| string/includes | 0.016ms | 0.100ms | 0.014ms | 0.016ms | gc-native |
| string/split | 0.363ms | 6.97ms | 2.60ms | FAILED | js |
| string/replace | 0.099ms | 0.542ms | 0.307ms | FAILED | js |
| string/case-convert | 0.052ms | 0.499ms | 0.256ms | FAILED | js |
| string/substring | 0.109ms | 0.038ms | 0.033ms | FAILED | gc-native |
| string/trim | 0.171ms | 3.50ms | 2.68ms | FAILED | js |
| string/startsWith-endsWith | 0.482ms | 2.74ms | 2.88ms | 0.567ms | js |
| array/push-pop | 1.50ms | 0.493ms | 0.495ms | FAILED | host-call |
| array/sort-i32 | 0.652ms | 0.341ms | 0.341ms | FAILED | gc-native |
| array/map-filter | 0.147ms | 0.082ms | 0.082ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.488ms | 0.488ms | FAILED | gc-native |
| array/indexOf | 5.39ms | 2.66ms | 2.66ms | FAILED | host-call |
| array/slice | 0.044ms | 0.042ms | 0.042ms | FAILED | host-call |
| array/reverse | 8.47ms | 3.80ms | 3.80ms | FAILED | host-call |
| array/forEach | 0.088ms | 0.025ms | 0.025ms | FAILED | host-call |
| array/find | 0.294ms | 0.017ms | 0.017ms | 0.997ms | host-call |
| dom/create-elements | 0.065ms | 0.157ms | — | — | js |
| dom/set-attributes | 0.130ms | 0.190ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.115ms | — | — | js |
| dom/modify-text | 0.060ms | 0.102ms | — | — | js |
| mixed/csv-parse | 0.403ms | 7.10ms | 0.588ms | FAILED | js |
| mixed/text-search | 0.441ms | 4.20ms | 2.61ms | 1.17ms | js |
| mixed/fibonacci | 0.137ms | 0.217ms | 0.217ms | 0.216ms | js |
| mixed/matrix-multiply | 0.189ms | 62.00ms | 63.67ms | 0.726ms | js |
| mixed/sieve | 1.67ms | 2.46ms | 2.47ms | FAILED | js |

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
| string/concat-short | 10000 | 5.58 | 5.70 | 6.72 | — |
| string/concat-long | 1000 | 5.51 | 5.65 | 6.46 | — |
| string/indexOf | 1000 | 16.58 | 52.72 | 11.59 | 35.23 |
| string/includes | 1000 | 16.40 | 99.59 | 14.39 | 15.72 |
| string/split | 10000 | 36.32 | 696.87 | 259.63 | — |
| string/replace | 1000 | 98.94 | 541.71 | 307.00 | — |
| string/case-convert | 2000 | 26.21 | 249.69 | 128.17 | — |
| string/substring | 10000 | 10.90 | 3.81 | 3.25 | — |
| string/trim | 10000 | 17.11 | 350.13 | 267.97 | — |
| string/startsWith-endsWith | 20000 | 24.11 | 136.88 | 143.92 | 28.37 |
| array/map-filter | 30000 | 4.91 | 2.74 | 2.73 | — |
| array/indexOf | 1000 | 5388.47 | 2662.93 | 2664.22 | — |
| dom/create-elements | 2000 | 32.37 | 78.73 | — | — |
| dom/set-attributes | 6000 | 21.62 | 31.71 | — | — |
| dom/read-attributes | 3000 | 24.43 | 38.38 | — | — |
| dom/modify-text | 2000 | 30.24 | 50.90 | — | — |
| mixed/csv-parse | 11000 | 36.68 | 645.35 | 53.47 | — |
| mixed/text-search | 40000 | 11.01 | 105.10 | 65.13 | 29.36 |
| mixed/fibonacci | 10000 | 13.66 | 21.69 | 21.68 | 21.58 |
| mixed/matrix-multiply | 125000 | 1.51 | 496.03 | 509.38 | 5.80 |
| mixed/sieve | 200000 | 8.36 | 12.29 | 12.34 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x slower | 1.20x slower | — |
| string/concat-long | 1.03x slower | 1.17x slower | — |
| string/indexOf | 3.18x slower | 1.43x faster | 2.12x slower |
| string/includes | 6.07x slower | 1.14x faster | 1.04x faster |
| string/split | 19.19x slower | 7.15x slower | — |
| string/replace | 5.47x slower | 3.10x slower | — |
| string/case-convert | 9.53x slower | 4.89x slower | — |
| string/substring | 2.86x faster | 3.35x faster | — |
| string/trim | 20.46x slower | 15.66x slower | — |
| string/startsWith-endsWith | 5.68x slower | 5.97x slower | 1.18x slower |
| array/push-pop | 3.05x faster | 3.03x faster | — |
| array/sort-i32 | 1.91x faster | 1.92x faster | — |
| array/map-filter | 1.80x faster | 1.80x faster | — |
| array/reduce | 4.38x faster | 4.39x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.06x faster | 1.06x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.49x faster | 3.49x faster | — |
| array/find | 17.61x faster | 17.51x faster | 3.39x slower |
| dom/create-elements | 2.43x slower | — | — |
| dom/set-attributes | 1.47x slower | — | — |
| dom/read-attributes | 1.57x slower | — | — |
| dom/modify-text | 1.68x slower | — | — |
| mixed/csv-parse | 17.60x slower | 1.46x slower | — |
| mixed/text-search | 9.54x slower | 5.91x slower | 2.67x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 327.74x slower | 336.57x slower | 3.84x slower |
| mixed/sieve | 1.47x slower | 1.48x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x slower |
| string/concat-long | 1.14x slower |
| string/indexOf | 4.55x faster |
| string/includes | 6.92x faster |
| string/split | 2.68x faster |
| string/replace | 1.76x faster |
| string/case-convert | 1.95x faster |
| string/substring | 1.17x faster |
| string/trim | 1.31x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 12.07x faster |
| mixed/text-search | 1.61x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.03x slower |
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
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1131.4ms | 632.7ms | — |
| string/concat-long | 447.5ms | 694.4ms | — |
| string/indexOf | 387.8ms | 682.9ms | 569.3ms |
| string/includes | 383.1ms | 682.1ms | 560.4ms |
| string/split | 528.7ms | 750.4ms | — |
| string/replace | 534.6ms | 747.9ms | — |
| string/case-convert | 527.3ms | 633.1ms | — |
| string/substring | 391.8ms | 501.1ms | — |
| string/trim | 513.1ms | 720.6ms | — |
| string/startsWith-endsWith | 509.5ms | 714.4ms | 634.2ms |
| array/push-pop | 512.5ms | 599.1ms | — |
| array/sort-i32 | 684.7ms | 719.9ms | — |
| array/map-filter | 691.7ms | 752.0ms | — |
| array/reduce | 653.3ms | 714.8ms | — |
| array/indexOf | 617.3ms | 708.0ms | — |
| array/slice | 507.1ms | 615.2ms | — |
| array/reverse | 523.3ms | 627.2ms | — |
| array/forEach | 662.7ms | 756.7ms | — |
| array/find | 493.9ms | 584.8ms | 559.7ms |
| dom/create-elements | 432.2ms | — | — |
| dom/set-attributes | 388.9ms | — | — |
| dom/read-attributes | 387.9ms | — | — |
| dom/modify-text | 384.2ms | — | — |
| mixed/csv-parse | 509.4ms | 705.4ms | — |
| mixed/text-search | 500.7ms | 712.3ms | 635.0ms |
| mixed/fibonacci | 448.4ms | 501.7ms | 463.8ms |
| mixed/matrix-multiply | 642.5ms | 702.4ms | 553.0ms |
| mixed/sieve | 616.0ms | 682.9ms | — |
