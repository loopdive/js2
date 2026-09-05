# js2wasm Benchmark Results

Date: 2026-09-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.043ms | 0.046ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.036ms | 0.009ms | 0.010ms | gc-native |
| string/includes | 0.012ms | 0.076ms | 0.011ms | 0.010ms | linear-memory |
| string/split | 0.259ms | 4.57ms | 1.71ms | FAILED | js |
| string/replace | 0.061ms | 0.359ms | 0.213ms | FAILED | js |
| string/case-convert | 0.043ms | 0.335ms | 0.168ms | FAILED | js |
| string/substring | 0.131ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.250ms | 2.25ms | 1.74ms | FAILED | js |
| string/startsWith-endsWith | 0.363ms | 1.85ms | 1.85ms | 0.396ms | js |
| array/push-pop | 1.22ms | 0.408ms | 0.409ms | FAILED | host-call |
| array/sort-i32 | 0.466ms | 0.251ms | 0.248ms | FAILED | gc-native |
| array/map-filter | 0.117ms | 0.068ms | 0.068ms | FAILED | gc-native |
| array/reduce | 1.24ms | 0.401ms | 0.402ms | FAILED | host-call |
| array/indexOf | 3.92ms | 1.88ms | 1.89ms | FAILED | host-call |
| array/slice | 0.046ms | 0.045ms | 0.043ms | FAILED | gc-native |
| array/reverse | 4.99ms | 2.73ms | 2.73ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.021ms | 0.021ms | FAILED | host-call |
| array/find | 0.221ms | 0.015ms | 0.015ms | 0.706ms | gc-native |
| dom/create-elements | 0.066ms | 0.124ms | — | — | js |
| dom/set-attributes | 0.112ms | 0.328ms | — | — | js |
| dom/read-attributes | 0.070ms | 0.092ms | — | — | js |
| dom/modify-text | 0.060ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.293ms | 5.58ms | 0.408ms | FAILED | js |
| mixed/text-search | 0.314ms | 2.68ms | 1.72ms | 0.814ms | js |
| mixed/fibonacci | 0.100ms | 0.161ms | 0.161ms | 0.159ms | js |
| mixed/matrix-multiply | 0.145ms | 42.73ms | 43.64ms | 0.526ms | js |
| mixed/sieve | 1.35ms | 1.83ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 4.55 | 4.31 | 4.60 | — |
| string/concat-long | 1000 | 3.83 | 4.47 | 6.47 | — |
| string/indexOf | 1000 | 11.85 | 36.30 | 8.71 | 9.80 |
| string/includes | 1000 | 11.82 | 76.02 | 10.87 | 10.26 |
| string/split | 10000 | 25.90 | 456.62 | 171.31 | — |
| string/replace | 1000 | 61.36 | 358.69 | 212.70 | — |
| string/case-convert | 2000 | 21.61 | 167.43 | 84.18 | — |
| string/substring | 10000 | 13.14 | 2.73 | 2.30 | — |
| string/trim | 10000 | 24.99 | 225.10 | 174.30 | — |
| string/startsWith-endsWith | 20000 | 18.17 | 92.73 | 92.64 | 19.81 |
| array/map-filter | 30000 | 3.88 | 2.27 | 2.27 | — |
| array/indexOf | 1000 | 3917.68 | 1880.58 | 1885.54 | — |
| dom/create-elements | 2000 | 33.11 | 61.75 | — | — |
| dom/set-attributes | 6000 | 18.65 | 54.65 | — | — |
| dom/read-attributes | 3000 | 23.46 | 30.80 | — | — |
| dom/modify-text | 2000 | 30.19 | 44.68 | — | — |
| mixed/csv-parse | 11000 | 26.60 | 507.32 | 37.12 | — |
| mixed/text-search | 40000 | 7.84 | 67.06 | 43.07 | 20.34 |
| mixed/fibonacci | 10000 | 10.00 | 16.05 | 16.07 | 15.85 |
| mixed/matrix-multiply | 125000 | 1.16 | 341.82 | 349.13 | 4.21 |
| mixed/sieve | 200000 | 6.74 | 9.14 | 9.14 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.05x faster | 1.01x slower | — |
| string/concat-long | 1.17x slower | 1.69x slower | — |
| string/indexOf | 3.06x slower | 1.36x faster | 1.21x faster |
| string/includes | 6.43x slower | 1.09x faster | 1.15x faster |
| string/split | 17.63x slower | 6.61x slower | — |
| string/replace | 5.85x slower | 3.47x slower | — |
| string/case-convert | 7.75x slower | 3.90x slower | — |
| string/substring | 4.81x faster | 5.70x faster | — |
| string/trim | 9.01x slower | 6.98x slower | — |
| string/startsWith-endsWith | 5.10x slower | 5.10x slower | 1.09x slower |
| array/push-pop | 2.98x faster | 2.98x faster | — |
| array/sort-i32 | 1.86x faster | 1.87x faster | — |
| array/map-filter | 1.71x faster | 1.71x faster | — |
| array/reduce | 3.11x faster | 3.10x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.02x faster | 1.07x faster | — |
| array/reverse | 1.83x faster | 1.83x faster | — |
| array/forEach | 2.55x faster | 2.54x faster | — |
| array/find | 14.63x faster | 14.69x faster | 3.20x slower |
| dom/create-elements | 1.87x slower | — | — |
| dom/set-attributes | 2.93x slower | — | — |
| dom/read-attributes | 1.31x slower | — | — |
| dom/modify-text | 1.48x slower | — | — |
| mixed/csv-parse | 19.07x slower | 1.40x slower | — |
| mixed/text-search | 8.55x slower | 5.49x slower | 2.59x slower |
| mixed/fibonacci | 1.61x slower | 1.61x slower | 1.59x slower |
| mixed/matrix-multiply | 294.24x slower | 300.54x slower | 3.62x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x slower |
| string/concat-long | 1.45x slower |
| string/indexOf | 4.17x faster |
| string/includes | 6.99x faster |
| string/split | 2.67x faster |
| string/replace | 1.69x faster |
| string/case-convert | 1.99x faster |
| string/substring | 1.19x faster |
| string/trim | 1.29x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.67x faster |
| mixed/text-search | 1.56x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1256.3ms | 786.6ms | — |
| string/concat-long | 594.5ms | 720.7ms | — |
| string/indexOf | 510.2ms | 722.5ms | 619.2ms |
| string/includes | 492.9ms | 707.8ms | 619.9ms |
| string/split | 576.3ms | 701.5ms | — |
| string/replace | 589.4ms | 766.3ms | — |
| string/case-convert | 619.3ms | 665.6ms | — |
| string/substring | 526.1ms | 616.8ms | — |
| string/trim | 572.7ms | 759.0ms | — |
| string/startsWith-endsWith | 576.5ms | 716.8ms | 679.4ms |
| array/push-pop | 592.7ms | 661.5ms | — |
| array/sort-i32 | 687.0ms | 735.0ms | — |
| array/map-filter | 730.5ms | 760.5ms | — |
| array/reduce | 660.5ms | 702.1ms | — |
| array/indexOf | 647.6ms | 710.5ms | — |
| array/slice | 585.3ms | 637.5ms | — |
| array/reverse | 593.2ms | 641.9ms | — |
| array/forEach | 666.8ms | 715.7ms | — |
| array/find | 566.8ms | 623.4ms | 621.8ms |
| dom/create-elements | 528.2ms | — | — |
| dom/set-attributes | 530.4ms | — | — |
| dom/read-attributes | 542.9ms | — | — |
| dom/modify-text | 514.6ms | — | — |
| mixed/csv-parse | 597.8ms | 735.1ms | — |
| mixed/text-search | 580.9ms | 703.0ms | 671.9ms |
| mixed/fibonacci | 607.8ms | 613.8ms | 595.7ms |
| mixed/matrix-multiply | 697.2ms | 721.1ms | 594.0ms |
| mixed/sieve | 628.3ms | 709.1ms | — |
