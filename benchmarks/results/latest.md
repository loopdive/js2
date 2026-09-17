# js2wasm Benchmark Results

Date: 2026-09-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.047ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.121ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.411ms | 8.36ms | 2.70ms | FAILED | js |
| string/replace | 0.104ms | 0.675ms | 0.319ms | FAILED | js |
| string/case-convert | 0.060ms | 0.565ms | 0.275ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.84ms | 2.99ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 3.04ms | 2.89ms | 0.561ms | js |
| array/push-pop | 1.38ms | 0.502ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.294ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.125ms | 0.069ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.506ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.015ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.165ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.475ms | 8.68ms | 0.618ms | FAILED | js |
| mixed/text-search | 0.389ms | 4.98ms | 2.76ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 72.12ms | 69.83ms | 0.716ms | js |
| mixed/sieve | 1.55ms | 2.11ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 3.13 | 4.67 | 4.45 | — |
| string/concat-long | 1000 | 3.56 | 4.53 | 3.60 | — |
| string/indexOf | 1000 | 19.12 | 63.90 | 12.19 | 14.58 |
| string/includes | 1000 | 19.15 | 121.03 | 14.76 | 16.49 |
| string/split | 10000 | 41.15 | 835.66 | 269.79 | — |
| string/replace | 1000 | 103.70 | 675.32 | 319.01 | — |
| string/case-convert | 2000 | 29.98 | 282.32 | 137.74 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.98 | 384.21 | 299.46 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 152.07 | 144.46 | 28.03 |
| array/map-filter | 30000 | 4.17 | 2.32 | 2.31 | — |
| array/indexOf | 1000 | 3950.81 | 2642.02 | 2638.24 | — |
| dom/create-elements | 2000 | 17.27 | 82.41 | — | — |
| dom/set-attributes | 6000 | 17.34 | 36.58 | — | — |
| dom/read-attributes | 3000 | 18.76 | 40.23 | — | — |
| dom/modify-text | 2000 | 14.30 | 56.58 | — | — |
| mixed/csv-parse | 11000 | 43.16 | 789.04 | 56.16 | — |
| mixed/text-search | 40000 | 9.73 | 124.61 | 69.03 | 27.07 |
| mixed/fibonacci | 10000 | 12.18 | 28.30 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 576.93 | 558.62 | 5.73 |
| mixed/sieve | 200000 | 7.75 | 10.53 | 10.46 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.42x slower | — |
| string/concat-long | 1.27x slower | 1.01x slower | — |
| string/indexOf | 3.34x slower | 1.57x faster | 1.31x faster |
| string/includes | 6.32x slower | 1.30x faster | 1.16x faster |
| string/split | 20.31x slower | 6.56x slower | — |
| string/replace | 6.51x slower | 3.08x slower | — |
| string/case-convert | 9.42x slower | 4.59x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 22.63x slower | 17.64x slower | — |
| string/startsWith-endsWith | 7.57x slower | 7.19x slower | 1.40x slower |
| array/push-pop | 2.75x faster | 2.76x faster | — |
| array/sort-i32 | 2.69x faster | 2.71x faster | — |
| array/map-filter | 1.80x faster | 1.81x faster | — |
| array/reduce | 4.24x faster | 4.27x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.10x faster | 3.11x faster | — |
| array/find | 16.32x faster | 16.41x faster | 4.25x slower |
| dom/create-elements | 4.77x slower | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.14x slower | — | — |
| dom/modify-text | 3.96x slower | — | — |
| mixed/csv-parse | 18.28x slower | 1.30x slower | — |
| mixed/text-search | 12.81x slower | 7.09x slower | 2.78x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 457.86x slower | 443.33x slower | 4.55x slower |
| mixed/sieve | 1.36x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.26x faster |
| string/indexOf | 5.24x faster |
| string/includes | 8.20x faster |
| string/split | 3.10x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.05x faster |
| string/substring | 1.22x faster |
| string/trim | 1.28x faster |
| string/startsWith-endsWith | 1.05x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.05x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x faster |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
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
| string/concat-short | 1110.6ms | 627.0ms | — |
| string/concat-long | 439.9ms | 640.7ms | — |
| string/indexOf | 371.4ms | 647.3ms | 547.1ms |
| string/includes | 353.7ms | 664.2ms | 532.8ms |
| string/split | 487.0ms | 674.8ms | — |
| string/replace | 495.0ms | 742.5ms | — |
| string/case-convert | 494.1ms | 580.9ms | — |
| string/substring | 388.4ms | 461.9ms | — |
| string/trim | 466.8ms | 670.8ms | — |
| string/startsWith-endsWith | 468.8ms | 689.6ms | 613.1ms |
| array/push-pop | 496.5ms | 568.7ms | — |
| array/sort-i32 | 663.0ms | 685.9ms | — |
| array/map-filter | 657.0ms | 725.4ms | — |
| array/reduce | 584.6ms | 676.2ms | — |
| array/indexOf | 551.4ms | 659.4ms | — |
| array/slice | 509.8ms | 566.8ms | — |
| array/reverse | 486.7ms | 564.7ms | — |
| array/forEach | 600.4ms | 614.0ms | — |
| array/find | 505.5ms | 553.6ms | 548.8ms |
| dom/create-elements | 397.2ms | — | — |
| dom/set-attributes | 369.4ms | — | — |
| dom/read-attributes | 374.1ms | — | — |
| dom/modify-text | 367.5ms | — | — |
| mixed/csv-parse | 487.0ms | 663.2ms | — |
| mixed/text-search | 493.0ms | 678.1ms | 630.0ms |
| mixed/fibonacci | 452.1ms | 483.0ms | 470.4ms |
| mixed/matrix-multiply | 605.2ms | 663.9ms | 505.7ms |
| mixed/sieve | 551.7ms | 634.7ms | — |
