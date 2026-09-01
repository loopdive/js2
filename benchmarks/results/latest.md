# js2wasm Benchmark Results

Date: 2026-09-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.046ms | 0.048ms | 0.054ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.012ms | 0.036ms | 0.009ms | 0.014ms | gc-native |
| string/includes | 0.012ms | 0.074ms | 0.011ms | 0.020ms | gc-native |
| string/split | 0.281ms | 4.52ms | 1.65ms | FAILED | js |
| string/replace | 0.060ms | 0.355ms | 0.205ms | FAILED | js |
| string/case-convert | 0.040ms | 0.325ms | 0.159ms | FAILED | js |
| string/substring | 0.120ms | 0.029ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.207ms | 2.21ms | 1.66ms | FAILED | js |
| string/startsWith-endsWith | 0.393ms | 1.78ms | 1.85ms | 0.391ms | linear-memory |
| array/push-pop | 1.01ms | 0.305ms | 0.339ms | FAILED | host-call |
| array/sort-i32 | 0.456ms | 0.247ms | 0.247ms | FAILED | host-call |
| array/map-filter | 0.112ms | 0.059ms | 0.061ms | FAILED | host-call |
| array/reduce | 1.52ms | 0.382ms | 0.331ms | FAILED | gc-native |
| array/indexOf | 3.94ms | 1.88ms | 1.88ms | FAILED | gc-native |
| array/slice | 0.028ms | 0.026ms | 0.028ms | FAILED | host-call |
| array/reverse | 5.52ms | 3.09ms | 2.72ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.018ms | 0.018ms | FAILED | host-call |
| array/find | 0.218ms | 0.011ms | 0.012ms | 0.705ms | host-call |
| dom/create-elements | 0.212ms | 0.132ms | — | — | host-call |
| dom/set-attributes | 0.103ms | 0.366ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.085ms | — | — | js |
| dom/modify-text | 0.051ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.295ms | 4.64ms | 0.395ms | FAILED | js |
| mixed/text-search | 0.306ms | 2.70ms | 1.79ms | 0.948ms | js |
| mixed/fibonacci | 0.099ms | 0.156ms | 0.156ms | 0.155ms | js |
| mixed/matrix-multiply | 0.143ms | 42.17ms | 43.73ms | 0.513ms | js |
| mixed/sieve | 1.19ms | 2.10ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 4.56 | 4.80 | 5.41 | — |
| string/concat-long | 1000 | 3.99 | 4.19 | 4.51 | — |
| string/indexOf | 1000 | 11.75 | 36.07 | 8.51 | 13.96 |
| string/includes | 1000 | 11.78 | 74.30 | 10.61 | 19.86 |
| string/split | 10000 | 28.06 | 451.86 | 165.45 | — |
| string/replace | 1000 | 60.10 | 355.11 | 205.42 | — |
| string/case-convert | 2000 | 20.23 | 162.44 | 79.41 | — |
| string/substring | 10000 | 11.97 | 2.92 | 2.30 | — |
| string/trim | 10000 | 20.68 | 220.84 | 166.45 | — |
| string/startsWith-endsWith | 20000 | 19.63 | 88.97 | 92.31 | 19.57 |
| array/map-filter | 30000 | 3.73 | 1.95 | 2.04 | — |
| array/indexOf | 1000 | 3935.51 | 1878.00 | 1875.63 | — |
| dom/create-elements | 2000 | 105.92 | 66.19 | — | — |
| dom/set-attributes | 6000 | 17.19 | 61.06 | — | — |
| dom/read-attributes | 3000 | 18.51 | 28.30 | — | — |
| dom/modify-text | 2000 | 25.68 | 43.78 | — | — |
| mixed/csv-parse | 11000 | 26.84 | 422.05 | 35.94 | — |
| mixed/text-search | 40000 | 7.64 | 67.40 | 44.69 | 23.70 |
| mixed/fibonacci | 10000 | 9.93 | 15.62 | 15.61 | 15.50 |
| mixed/matrix-multiply | 125000 | 1.14 | 337.40 | 349.84 | 4.11 |
| mixed/sieve | 200000 | 5.97 | 10.48 | 9.06 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.05x slower | 1.19x slower | — |
| string/concat-long | 1.05x slower | 1.13x slower | — |
| string/indexOf | 3.07x slower | 1.38x faster | 1.19x slower |
| string/includes | 6.31x slower | 1.11x faster | 1.69x slower |
| string/split | 16.10x slower | 5.90x slower | — |
| string/replace | 5.91x slower | 3.42x slower | — |
| string/case-convert | 8.03x slower | 3.93x slower | — |
| string/substring | 4.10x faster | 5.19x faster | — |
| string/trim | 10.68x slower | 8.05x slower | — |
| string/startsWith-endsWith | 4.53x slower | 4.70x slower | 1.00x faster |
| array/push-pop | 3.30x faster | 2.96x faster | — |
| array/sort-i32 | 1.85x faster | 1.84x faster | — |
| array/map-filter | 1.91x faster | 1.83x faster | — |
| array/reduce | 3.97x faster | 4.59x faster | — |
| array/indexOf | 2.10x faster | 2.10x faster | — |
| array/slice | 1.09x faster | 1.00x slower | — |
| array/reverse | 1.78x faster | 2.03x faster | — |
| array/forEach | 2.79x faster | 2.74x faster | — |
| array/find | 19.46x faster | 18.26x faster | 3.24x slower |
| dom/create-elements | 1.60x faster | — | — |
| dom/set-attributes | 3.55x slower | — | — |
| dom/read-attributes | 1.53x slower | — | — |
| dom/modify-text | 1.70x slower | — | — |
| mixed/csv-parse | 15.72x slower | 1.34x slower | — |
| mixed/text-search | 8.82x slower | 5.85x slower | 3.10x slower |
| mixed/fibonacci | 1.57x slower | 1.57x slower | 1.56x slower |
| mixed/matrix-multiply | 295.11x slower | 306.00x slower | 3.59x slower |
| mixed/sieve | 1.76x slower | 1.52x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x slower |
| string/concat-long | 1.08x slower |
| string/indexOf | 4.24x faster |
| string/includes | 7.00x faster |
| string/split | 2.73x faster |
| string/replace | 1.73x faster |
| string/case-convert | 2.05x faster |
| string/substring | 1.27x faster |
| string/trim | 1.33x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.11x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.04x slower |
| array/reduce | 1.15x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.09x slower |
| array/reverse | 1.14x faster |
| array/forEach | 1.02x slower |
| array/find | 1.07x slower |
| mixed/csv-parse | 11.74x faster |
| mixed/text-search | 1.51x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.16x faster |

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
| string/concat-short | 1156.9ms | 740.9ms | — |
| string/concat-long | 535.9ms | 672.7ms | — |
| string/indexOf | 478.0ms | 672.8ms | 595.5ms |
| string/includes | 473.5ms | 678.4ms | 581.5ms |
| string/split | 551.4ms | 675.4ms | — |
| string/replace | 551.3ms | 716.0ms | — |
| string/case-convert | 556.9ms | 646.2ms | — |
| string/substring | 474.6ms | 527.2ms | — |
| string/trim | 526.8ms | 671.6ms | — |
| string/startsWith-endsWith | 586.9ms | 695.5ms | 635.7ms |
| array/push-pop | 553.4ms | 604.4ms | — |
| array/sort-i32 | 638.3ms | 710.9ms | — |
| array/map-filter | 667.1ms | 779.3ms | — |
| array/reduce | 625.1ms | 679.8ms | — |
| array/indexOf | 644.8ms | 673.7ms | — |
| array/slice | 553.1ms | 604.3ms | — |
| array/reverse | 601.0ms | 603.4ms | — |
| array/forEach | 618.9ms | 686.6ms | — |
| array/find | 540.2ms | 592.8ms | 571.3ms |
| dom/create-elements | 523.1ms | — | — |
| dom/set-attributes | 522.5ms | — | — |
| dom/read-attributes | 523.5ms | — | — |
| dom/modify-text | 516.1ms | — | — |
| mixed/csv-parse | 581.1ms | 689.0ms | — |
| mixed/text-search | 554.7ms | 689.0ms | 670.8ms |
| mixed/fibonacci | 534.8ms | 558.9ms | 546.0ms |
| mixed/matrix-multiply | 623.4ms | 699.5ms | 565.6ms |
| mixed/sieve | 593.1ms | 652.7ms | — |
