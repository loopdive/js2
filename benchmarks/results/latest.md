# js2wasm Benchmark Results

Date: 2026-09-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.046ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.020ms | 0.139ms | 0.015ms | 0.020ms | gc-native |
| string/split | 3.14ms | 8.46ms | 2.81ms | FAILED | gc-native |
| string/replace | 0.104ms | 0.707ms | 0.331ms | FAILED | js |
| string/case-convert | 0.056ms | 0.588ms | 0.267ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.04ms | 2.83ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 3.02ms | 3.05ms | 0.561ms | js |
| array/push-pop | 1.42ms | 0.502ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.806ms | 0.294ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.511ms | 0.509ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.262ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.093ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.221ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.130ms | — | — | js |
| dom/modify-text | 0.030ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.488ms | 8.63ms | 0.646ms | FAILED | js |
| mixed/text-search | 0.389ms | 4.87ms | 2.88ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 75.04ms | 77.50ms | 0.715ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.61 | 4.64 | 4.21 | — |
| string/concat-long | 1000 | 3.58 | 4.57 | 3.67 | — |
| string/indexOf | 1000 | 19.20 | 63.74 | 12.26 | 14.58 |
| string/includes | 1000 | 19.57 | 139.24 | 14.78 | 20.47 |
| string/split | 10000 | 313.92 | 846.38 | 281.11 | — |
| string/replace | 1000 | 104.27 | 706.93 | 331.49 | — |
| string/case-convert | 2000 | 27.87 | 293.76 | 133.47 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.03 | 404.22 | 283.21 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 150.81 | 152.32 | 28.04 |
| array/map-filter | 30000 | 4.33 | 2.36 | 2.36 | — |
| array/indexOf | 1000 | 3957.40 | 2641.24 | 2638.04 | — |
| dom/create-elements | 2000 | 17.71 | 46.56 | — | — |
| dom/set-attributes | 6000 | 17.47 | 36.81 | — | — |
| dom/read-attributes | 3000 | 18.25 | 43.22 | — | — |
| dom/modify-text | 2000 | 14.92 | 53.90 | — | — |
| mixed/csv-parse | 11000 | 44.39 | 784.66 | 58.74 | — |
| mixed/text-search | 40000 | 9.73 | 121.80 | 71.88 | 27.33 |
| mixed/fibonacci | 10000 | 12.03 | 28.32 | 28.31 | 28.09 |
| mixed/matrix-multiply | 125000 | 1.26 | 600.35 | 619.96 | 5.72 |
| mixed/sieve | 200000 | 7.82 | 10.56 | 10.62 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.28x slower | 1.16x slower | — |
| string/concat-long | 1.28x slower | 1.03x slower | — |
| string/indexOf | 3.32x slower | 1.57x faster | 1.32x faster |
| string/includes | 7.11x slower | 1.32x faster | 1.05x slower |
| string/split | 2.70x slower | 1.12x faster | — |
| string/replace | 6.78x slower | 3.18x slower | — |
| string/case-convert | 10.54x slower | 4.79x slower | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 23.74x slower | 16.63x slower | — |
| string/startsWith-endsWith | 7.51x slower | 7.59x slower | 1.40x slower |
| array/push-pop | 2.82x faster | 2.82x faster | — |
| array/sort-i32 | 2.75x faster | 2.75x faster | — |
| array/map-filter | 1.83x faster | 1.84x faster | — |
| array/reduce | 4.20x faster | 4.22x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 16.42x faster | 16.56x faster | 4.11x slower |
| dom/create-elements | 2.63x slower | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.37x slower | — | — |
| dom/modify-text | 3.61x slower | — | — |
| mixed/csv-parse | 17.68x slower | 1.32x slower | — |
| mixed/text-search | 12.52x slower | 7.39x slower | 2.81x slower |
| mixed/fibonacci | 2.36x slower | 2.35x slower | 2.34x slower |
| mixed/matrix-multiply | 475.18x slower | 490.71x slower | 4.53x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.20x faster |
| string/includes | 9.42x faster |
| string/split | 3.01x faster |
| string/replace | 2.13x faster |
| string/case-convert | 2.20x faster |
| string/substring | 1.22x faster |
| string/trim | 1.43x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.36x faster |
| mixed/text-search | 1.69x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.03x slower |
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
| string/concat-short | 1152.2ms | 618.7ms | — |
| string/concat-long | 445.2ms | 668.3ms | — |
| string/indexOf | 389.0ms | 671.3ms | 552.0ms |
| string/includes | 383.5ms | 679.7ms | 554.3ms |
| string/split | 502.0ms | 678.3ms | — |
| string/replace | 522.7ms | 756.3ms | — |
| string/case-convert | 511.4ms | 604.9ms | — |
| string/substring | 384.2ms | 484.5ms | — |
| string/trim | 486.0ms | 681.9ms | — |
| string/startsWith-endsWith | 469.7ms | 683.4ms | 617.6ms |
| array/push-pop | 530.9ms | 578.1ms | — |
| array/sort-i32 | 663.6ms | 692.7ms | — |
| array/map-filter | 680.0ms | 773.0ms | — |
| array/reduce | 647.9ms | 714.1ms | — |
| array/indexOf | 608.3ms | 683.6ms | — |
| array/slice | 527.9ms | 599.8ms | — |
| array/reverse | 505.0ms | 589.1ms | — |
| array/forEach | 633.6ms | 723.8ms | — |
| array/find | 491.5ms | 582.8ms | 543.8ms |
| dom/create-elements | 417.3ms | — | — |
| dom/set-attributes | 369.8ms | — | — |
| dom/read-attributes | 391.4ms | — | — |
| dom/modify-text | 359.0ms | — | — |
| mixed/csv-parse | 524.6ms | 666.1ms | — |
| mixed/text-search | 500.9ms | 699.6ms | 621.3ms |
| mixed/fibonacci | 440.3ms | 516.9ms | 470.8ms |
| mixed/matrix-multiply | 630.0ms | 699.7ms | 533.5ms |
| mixed/sieve | 595.8ms | 685.3ms | — |
