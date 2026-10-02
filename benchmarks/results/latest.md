# js2wasm Benchmark Results

Date: 2026-10-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.148ms | 0.015ms | 0.030ms | gc-native |
| string/split | 0.428ms | 8.48ms | 2.94ms | FAILED | js |
| string/replace | 0.108ms | 0.689ms | 0.309ms | FAILED | js |
| string/case-convert | 0.056ms | 0.651ms | 0.264ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 4.13ms | 2.84ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.98ms | 2.97ms | 0.562ms | js |
| array/push-pop | 1.41ms | 0.506ms | 0.506ms | FAILED | host-call |
| array/sort-i32 | 0.792ms | 0.293ms | 0.295ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.508ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.170ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.218ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.488ms | 8.72ms | 0.648ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.28ms | 2.79ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.163ms | 76.46ms | 77.60ms | 0.722ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.26 | 4.75 | 4.42 | — |
| string/concat-long | 1000 | 3.57 | 4.58 | 3.60 | — |
| string/indexOf | 1000 | 19.14 | 64.11 | 12.05 | 15.37 |
| string/includes | 1000 | 19.23 | 147.88 | 14.80 | 30.35 |
| string/split | 10000 | 42.83 | 847.66 | 293.68 | — |
| string/replace | 1000 | 108.32 | 689.15 | 308.61 | — |
| string/case-convert | 2000 | 28.05 | 325.28 | 132.01 | — |
| string/substring | 10000 | 9.91 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.06 | 412.96 | 283.51 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 148.90 | 148.36 | 28.10 |
| array/map-filter | 30000 | 4.31 | 2.34 | 2.36 | — |
| array/indexOf | 1000 | 3951.55 | 2644.44 | 2643.67 | — |
| dom/create-elements | 2000 | 17.45 | 84.87 | — | — |
| dom/set-attributes | 6000 | 17.16 | 36.31 | — | — |
| dom/read-attributes | 3000 | 18.32 | 41.14 | — | — |
| dom/modify-text | 2000 | 14.34 | 53.93 | — | — |
| mixed/csv-parse | 11000 | 44.39 | 792.41 | 58.87 | — |
| mixed/text-search | 40000 | 9.73 | 132.12 | 69.74 | 27.13 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.30 | 611.67 | 620.78 | 5.77 |
| mixed/sieve | 200000 | 7.81 | 10.53 | 10.66 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.36x slower | — |
| string/concat-long | 1.28x slower | 1.01x slower | — |
| string/indexOf | 3.35x slower | 1.59x faster | 1.25x faster |
| string/includes | 7.69x slower | 1.30x faster | 1.58x slower |
| string/split | 19.79x slower | 6.86x slower | — |
| string/replace | 6.36x slower | 2.85x slower | — |
| string/case-convert | 11.60x slower | 4.71x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 24.21x slower | 16.62x slower | — |
| string/startsWith-endsWith | 7.43x slower | 7.41x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.79x faster | — |
| array/sort-i32 | 2.70x faster | 2.68x faster | — |
| array/map-filter | 1.84x faster | 1.83x faster | — |
| array/reduce | 4.25x faster | 4.29x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.07x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.09x faster | 3.10x faster | — |
| array/find | 15.96x faster | 16.07x faster | 4.26x slower |
| dom/create-elements | 4.86x slower | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 17.85x slower | 1.33x slower | — |
| mixed/text-search | 13.58x slower | 7.17x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 470.05x slower | 477.05x slower | 4.44x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 5.32x faster |
| string/includes | 9.99x faster |
| string/split | 2.89x faster |
| string/replace | 2.23x faster |
| string/case-convert | 2.46x faster |
| string/substring | 1.22x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.46x faster |
| mixed/text-search | 1.89x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
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
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1169.3ms | 597.2ms | — |
| string/concat-long | 447.5ms | 657.2ms | — |
| string/indexOf | 388.7ms | 667.6ms | 552.4ms |
| string/includes | 371.8ms | 671.3ms | 563.9ms |
| string/split | 508.1ms | 677.8ms | — |
| string/replace | 528.1ms | 750.8ms | — |
| string/case-convert | 539.2ms | 665.4ms | — |
| string/substring | 391.9ms | 470.4ms | — |
| string/trim | 472.4ms | 692.5ms | — |
| string/startsWith-endsWith | 519.1ms | 695.3ms | 616.8ms |
| array/push-pop | 525.3ms | 581.0ms | — |
| array/sort-i32 | 666.7ms | 730.7ms | — |
| array/map-filter | 690.6ms | 765.9ms | — |
| array/reduce | 613.9ms | 696.9ms | — |
| array/indexOf | 609.9ms | 675.5ms | — |
| array/slice | 525.3ms | 611.1ms | — |
| array/reverse | 516.6ms | 576.6ms | — |
| array/forEach | 634.6ms | 692.4ms | — |
| array/find | 481.4ms | 597.5ms | 551.1ms |
| dom/create-elements | 406.4ms | — | — |
| dom/set-attributes | 395.8ms | — | — |
| dom/read-attributes | 382.1ms | — | — |
| dom/modify-text | 372.8ms | — | — |
| mixed/csv-parse | 522.4ms | 679.1ms | — |
| mixed/text-search | 518.2ms | 703.0ms | 617.7ms |
| mixed/fibonacci | 450.4ms | 488.2ms | 472.5ms |
| mixed/matrix-multiply | 628.0ms | 716.5ms | 529.1ms |
| mixed/sieve | 608.1ms | 677.2ms | — |
