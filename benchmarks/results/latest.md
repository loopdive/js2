# js2wasm Benchmark Results

Date: 2026-09-26
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.049ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.113ms | 0.015ms | 0.017ms | gc-native |
| string/split | 0.424ms | 8.16ms | 2.81ms | FAILED | js |
| string/replace | 0.111ms | 0.684ms | 0.330ms | FAILED | js |
| string/case-convert | 0.056ms | 0.560ms | 0.275ms | FAILED | js |
| string/substring | 0.100ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.97ms | 2.81ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.99ms | 2.94ms | 0.562ms | js |
| array/push-pop | 1.41ms | 0.502ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.797ms | 0.295ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.500ms | 0.499ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.163ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.222ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.105ms | — | — | js |
| mixed/csv-parse | 0.490ms | 8.44ms | 0.649ms | FAILED | js |
| mixed/text-search | 0.480ms | 5.09ms | 2.94ms | 1.11ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 73.35ms | 76.78ms | 0.719ms | js |
| mixed/sieve | 1.58ms | 2.10ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.48 | 4.87 | 4.15 | — |
| string/concat-long | 1000 | 3.71 | 4.53 | 3.75 | — |
| string/indexOf | 1000 | 19.15 | 65.65 | 12.21 | 16.10 |
| string/includes | 1000 | 19.19 | 112.59 | 14.75 | 17.29 |
| string/split | 10000 | 42.43 | 815.68 | 280.82 | — |
| string/replace | 1000 | 111.44 | 684.05 | 330.28 | — |
| string/case-convert | 2000 | 27.96 | 280.10 | 137.26 | — |
| string/substring | 10000 | 10.01 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.03 | 396.68 | 281.44 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 149.58 | 147.02 | 28.08 |
| array/map-filter | 30000 | 4.25 | 2.35 | 2.34 | — |
| array/indexOf | 1000 | 3950.95 | 2642.87 | 2640.66 | — |
| dom/create-elements | 2000 | 17.42 | 81.65 | — | — |
| dom/set-attributes | 6000 | 17.09 | 36.96 | — | — |
| dom/read-attributes | 3000 | 18.59 | 40.32 | — | — |
| dom/modify-text | 2000 | 14.59 | 52.72 | — | — |
| mixed/csv-parse | 11000 | 44.56 | 766.85 | 58.97 | — |
| mixed/text-search | 40000 | 12.01 | 127.27 | 73.56 | 27.73 |
| mixed/fibonacci | 10000 | 12.19 | 28.31 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 586.80 | 614.25 | 5.75 |
| mixed/sieve | 200000 | 7.92 | 10.50 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.19x slower | — |
| string/concat-long | 1.22x slower | 1.01x slower | — |
| string/indexOf | 3.43x slower | 1.57x faster | 1.19x faster |
| string/includes | 5.87x slower | 1.30x faster | 1.11x faster |
| string/split | 19.22x slower | 6.62x slower | — |
| string/replace | 6.14x slower | 2.96x slower | — |
| string/case-convert | 10.02x slower | 4.91x slower | — |
| string/substring | 2.68x faster | 3.25x faster | — |
| string/trim | 23.29x slower | 16.53x slower | — |
| string/startsWith-endsWith | 7.45x slower | 7.32x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.79x faster | — |
| array/sort-i32 | 2.70x faster | 2.72x faster | — |
| array/map-filter | 1.81x faster | 1.81x faster | — |
| array/reduce | 4.34x faster | 4.35x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.77x faster | — |
| array/find | 16.25x faster | 16.24x faster | 4.24x slower |
| dom/create-elements | 4.69x slower | — | — |
| dom/set-attributes | 2.16x slower | — | — |
| dom/read-attributes | 2.17x slower | — | — |
| dom/modify-text | 3.61x slower | — | — |
| mixed/csv-parse | 17.21x slower | 1.32x slower | — |
| mixed/text-search | 10.60x slower | 6.12x slower | 2.31x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 466.99x slower | 488.84x slower | 4.58x slower |
| mixed/sieve | 1.33x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.38x faster |
| string/includes | 7.63x faster |
| string/split | 2.90x faster |
| string/replace | 2.07x faster |
| string/case-convert | 2.04x faster |
| string/substring | 1.22x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.00x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.05x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1151.7ms | 639.4ms | — |
| string/concat-long | 440.2ms | 668.0ms | — |
| string/indexOf | 361.1ms | 675.8ms | 551.3ms |
| string/includes | 367.1ms | 666.9ms | 546.6ms |
| string/split | 526.6ms | 696.2ms | — |
| string/replace | 508.0ms | 751.5ms | — |
| string/case-convert | 504.7ms | 624.4ms | — |
| string/substring | 381.4ms | 478.3ms | — |
| string/trim | 475.3ms | 675.1ms | — |
| string/startsWith-endsWith | 487.2ms | 686.8ms | 619.8ms |
| array/push-pop | 499.3ms | 589.3ms | — |
| array/sort-i32 | 658.6ms | 729.5ms | — |
| array/map-filter | 694.7ms | 732.3ms | — |
| array/reduce | 616.1ms | 703.6ms | — |
| array/indexOf | 592.0ms | 691.0ms | — |
| array/slice | 512.8ms | 609.2ms | — |
| array/reverse | 502.3ms | 591.7ms | — |
| array/forEach | 653.7ms | 710.8ms | — |
| array/find | 491.9ms | 602.8ms | 549.5ms |
| dom/create-elements | 419.1ms | — | — |
| dom/set-attributes | 393.5ms | — | — |
| dom/read-attributes | 374.5ms | — | — |
| dom/modify-text | 376.3ms | — | — |
| mixed/csv-parse | 518.7ms | 672.0ms | — |
| mixed/text-search | 494.5ms | 728.7ms | 613.3ms |
| mixed/fibonacci | 452.8ms | 479.4ms | 477.2ms |
| mixed/matrix-multiply | 649.4ms | 700.2ms | 527.2ms |
| mixed/sieve | 618.2ms | 702.4ms | — |
