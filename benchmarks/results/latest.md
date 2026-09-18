# js2wasm Benchmark Results

Date: 2026-09-18
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.014ms | 0.027ms | gc-native |
| string/split | 0.412ms | 8.29ms | 2.79ms | FAILED | js |
| string/replace | 0.104ms | 0.689ms | 0.311ms | FAILED | js |
| string/case-convert | 0.056ms | 0.577ms | 0.274ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.85ms | 2.79ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.93ms | 3.07ms | 0.562ms | js |
| array/push-pop | 1.42ms | 0.524ms | 0.505ms | FAILED | gc-native |
| array/sort-i32 | 0.794ms | 0.294ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.132ms | 0.072ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.19ms | 0.515ms | 0.518ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.030ms | 0.031ms | FAILED | host-call |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.089ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/find | 0.257ms | 0.017ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.043ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.122ms | — | — | js |
| dom/modify-text | 0.032ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.483ms | 8.65ms | 0.621ms | FAILED | js |
| mixed/text-search | 0.438ms | 5.32ms | 2.85ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 71.09ms | 71.43ms | 0.719ms | js |
| mixed/sieve | 1.60ms | 2.16ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.30 | 4.86 | 4.43 | — |
| string/concat-long | 1000 | 3.89 | 4.62 | 4.33 | — |
| string/indexOf | 1000 | 19.37 | 63.95 | 12.36 | 14.58 |
| string/includes | 1000 | 19.28 | 119.70 | 14.48 | 27.14 |
| string/split | 10000 | 41.19 | 829.32 | 279.16 | — |
| string/replace | 1000 | 103.89 | 689.16 | 311.11 | — |
| string/case-convert | 2000 | 28.03 | 288.54 | 137.01 | — |
| string/substring | 10000 | 9.91 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 384.71 | 279.18 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 146.28 | 153.34 | 28.08 |
| array/map-filter | 30000 | 4.39 | 2.39 | 2.42 | — |
| array/indexOf | 1000 | 3956.01 | 2643.99 | 2643.04 | — |
| dom/create-elements | 2000 | 21.69 | 47.63 | — | — |
| dom/set-attributes | 6000 | 18.17 | 36.14 | — | — |
| dom/read-attributes | 3000 | 19.92 | 40.53 | — | — |
| dom/modify-text | 2000 | 15.79 | 53.61 | — | — |
| mixed/csv-parse | 11000 | 43.94 | 786.44 | 56.48 | — |
| mixed/text-search | 40000 | 10.95 | 132.93 | 71.26 | 27.01 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.31 | 28.13 |
| mixed/matrix-multiply | 125000 | 1.27 | 568.69 | 571.42 | 5.75 |
| mixed/sieve | 200000 | 8.02 | 10.80 | 10.61 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.34x slower | — |
| string/concat-long | 1.19x slower | 1.11x slower | — |
| string/indexOf | 3.30x slower | 1.57x faster | 1.33x faster |
| string/includes | 6.21x slower | 1.33x faster | 1.41x slower |
| string/split | 20.13x slower | 6.78x slower | — |
| string/replace | 6.63x slower | 2.99x slower | — |
| string/case-convert | 10.29x slower | 4.89x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 22.61x slower | 16.41x slower | — |
| string/startsWith-endsWith | 7.29x slower | 7.64x slower | 1.40x slower |
| array/push-pop | 2.72x faster | 2.82x faster | — |
| array/sort-i32 | 2.70x faster | 2.70x faster | — |
| array/map-filter | 1.84x faster | 1.82x faster | — |
| array/reduce | 4.26x faster | 4.23x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.04x faster | 1.01x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 3.16x faster | 3.11x faster | — |
| array/find | 15.29x faster | 15.78x faster | 4.21x slower |
| dom/create-elements | 2.20x slower | — | — |
| dom/set-attributes | 1.99x slower | — | — |
| dom/read-attributes | 2.03x slower | — | — |
| dom/modify-text | 3.40x slower | — | — |
| mixed/csv-parse | 17.90x slower | 1.29x slower | — |
| mixed/text-search | 12.13x slower | 6.50x slower | 2.47x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 446.13x slower | 448.27x slower | 4.51x slower |
| mixed/sieve | 1.35x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.07x faster |
| string/indexOf | 5.17x faster |
| string/includes | 8.27x faster |
| string/split | 2.97x faster |
| string/replace | 2.22x faster |
| string/case-convert | 2.11x faster |
| string/substring | 1.22x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.04x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.02x slower |
| array/find | 1.03x faster |
| mixed/csv-parse | 13.92x faster |
| mixed/text-search | 1.87x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x faster |

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
| array/sort-i32 | 3.1KB | 3.5KB | — |
| array/map-filter | 4.2KB | 4.7KB | — |
| array/reduce | 2.8KB | 3.3KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 3.2KB | 3.7KB | — |
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
| string/concat-short | 1141.2ms | 640.3ms | — |
| string/concat-long | 447.0ms | 658.5ms | — |
| string/indexOf | 387.6ms | 680.9ms | 538.1ms |
| string/includes | 366.4ms | 677.3ms | 557.9ms |
| string/split | 505.0ms | 674.7ms | — |
| string/replace | 491.4ms | 764.8ms | — |
| string/case-convert | 506.2ms | 611.8ms | — |
| string/substring | 390.5ms | 494.0ms | — |
| string/trim | 477.6ms | 671.6ms | — |
| string/startsWith-endsWith | 499.9ms | 685.2ms | 609.5ms |
| array/push-pop | 502.5ms | 559.9ms | — |
| array/sort-i32 | 651.2ms | 721.9ms | — |
| array/map-filter | 713.7ms | 783.3ms | — |
| array/reduce | 618.8ms | 700.1ms | — |
| array/indexOf | 572.6ms | 684.7ms | — |
| array/slice | 501.3ms | 595.5ms | — |
| array/reverse | 487.6ms | 566.9ms | — |
| array/forEach | 636.7ms | 744.4ms | — |
| array/find | 483.2ms | 572.7ms | 559.6ms |
| dom/create-elements | 430.2ms | — | — |
| dom/set-attributes | 382.1ms | — | — |
| dom/read-attributes | 380.9ms | — | — |
| dom/modify-text | 368.5ms | — | — |
| mixed/csv-parse | 528.7ms | 677.8ms | — |
| mixed/text-search | 493.3ms | 686.3ms | 618.8ms |
| mixed/fibonacci | 455.2ms | 510.8ms | 485.3ms |
| mixed/matrix-multiply | 611.7ms | 695.1ms | 528.4ms |
| mixed/sieve | 576.6ms | 645.2ms | — |
