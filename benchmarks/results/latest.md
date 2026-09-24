# js2wasm Benchmark Results

Date: 2026-09-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.048ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.116ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.423ms | 8.48ms | 2.87ms | FAILED | js |
| string/replace | 0.102ms | 0.718ms | 0.329ms | FAILED | js |
| string/case-convert | 0.056ms | 0.592ms | 0.276ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.07ms | 2.85ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.96ms | 3.05ms | 0.561ms | js |
| array/push-pop | 1.43ms | 0.511ms | 0.507ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.295ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.505ms | 0.506ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.030ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.041ms | 0.100ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.126ms | — | — | js |
| dom/modify-text | 0.030ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.54ms | 0.642ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.14ms | 2.90ms | 1.12ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.285ms | js |
| mixed/matrix-multiply | 0.164ms | 79.21ms | 82.50ms | 0.718ms | js |
| mixed/sieve | 1.58ms | 2.11ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.40 | 4.77 | 4.16 | — |
| string/concat-long | 1000 | 3.72 | 4.54 | 4.05 | — |
| string/indexOf | 1000 | 19.22 | 64.01 | 12.36 | 16.85 |
| string/includes | 1000 | 19.31 | 116.35 | 15.00 | 15.43 |
| string/split | 10000 | 42.31 | 847.61 | 286.59 | — |
| string/replace | 1000 | 102.08 | 718.37 | 329.19 | — |
| string/case-convert | 2000 | 27.78 | 296.23 | 138.08 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 406.64 | 284.50 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 147.99 | 152.46 | 28.03 |
| array/map-filter | 30000 | 4.31 | 2.35 | 2.37 | — |
| array/indexOf | 1000 | 3950.02 | 2642.98 | 2641.46 | — |
| dom/create-elements | 2000 | 20.68 | 50.11 | — | — |
| dom/set-attributes | 6000 | 17.56 | 36.53 | — | — |
| dom/read-attributes | 3000 | 18.72 | 42.02 | — | — |
| dom/modify-text | 2000 | 15.00 | 54.71 | — | — |
| mixed/csv-parse | 11000 | 44.23 | 776.37 | 58.33 | — |
| mixed/text-search | 40000 | 9.71 | 128.51 | 72.55 | 28.04 |
| mixed/fibonacci | 10000 | 12.02 | 28.30 | 28.30 | 28.54 |
| mixed/matrix-multiply | 125000 | 1.31 | 633.71 | 660.04 | 5.75 |
| mixed/sieve | 200000 | 7.92 | 10.57 | 10.69 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.22x slower | — |
| string/concat-long | 1.22x slower | 1.09x slower | — |
| string/indexOf | 3.33x slower | 1.55x faster | 1.14x faster |
| string/includes | 6.02x slower | 1.29x faster | 1.25x faster |
| string/split | 20.03x slower | 6.77x slower | — |
| string/replace | 7.04x slower | 3.22x slower | — |
| string/case-convert | 10.67x slower | 4.97x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.93x slower | 16.74x slower | — |
| string/startsWith-endsWith | 7.39x slower | 7.61x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.83x faster | — |
| array/sort-i32 | 2.68x faster | 2.70x faster | — |
| array/map-filter | 1.83x faster | 1.82x faster | — |
| array/reduce | 4.29x faster | 4.29x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.02x faster | 1.04x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.81x faster | 1.82x faster | — |
| array/find | 15.92x faster | 15.84x faster | 4.24x slower |
| dom/create-elements | 2.42x slower | — | — |
| dom/set-attributes | 2.08x slower | — | — |
| dom/read-attributes | 2.24x slower | — | — |
| dom/modify-text | 3.65x slower | — | — |
| mixed/csv-parse | 17.55x slower | 1.32x slower | — |
| mixed/text-search | 13.24x slower | 7.48x slower | 2.89x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.37x slower |
| mixed/matrix-multiply | 484.48x slower | 504.61x slower | 4.39x slower |
| mixed/sieve | 1.34x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.12x faster |
| string/indexOf | 5.18x faster |
| string/includes | 7.76x faster |
| string/split | 2.96x faster |
| string/replace | 2.18x faster |
| string/case-convert | 2.15x faster |
| string/substring | 1.22x faster |
| string/trim | 1.43x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.31x faster |
| mixed/text-search | 1.77x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
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
| string/concat-short | 1164.4ms | 646.1ms | — |
| string/concat-long | 439.6ms | 661.9ms | — |
| string/indexOf | 384.7ms | 676.2ms | 556.6ms |
| string/includes | 395.8ms | 698.0ms | 563.0ms |
| string/split | 536.0ms | 708.2ms | — |
| string/replace | 520.3ms | 772.9ms | — |
| string/case-convert | 529.3ms | 613.7ms | — |
| string/substring | 421.9ms | 499.0ms | — |
| string/trim | 503.9ms | 676.0ms | — |
| string/startsWith-endsWith | 489.4ms | 698.5ms | 630.4ms |
| array/push-pop | 513.5ms | 608.1ms | — |
| array/sort-i32 | 684.8ms | 733.4ms | — |
| array/map-filter | 699.4ms | 743.8ms | — |
| array/reduce | 618.5ms | 702.1ms | — |
| array/indexOf | 600.2ms | 714.8ms | — |
| array/slice | 515.7ms | 598.7ms | — |
| array/reverse | 502.4ms | 599.2ms | — |
| array/forEach | 679.2ms | 720.2ms | — |
| array/find | 504.8ms | 601.1ms | 556.6ms |
| dom/create-elements | 423.9ms | — | — |
| dom/set-attributes | 392.0ms | — | — |
| dom/read-attributes | 401.2ms | — | — |
| dom/modify-text | 381.8ms | — | — |
| mixed/csv-parse | 515.3ms | 694.7ms | — |
| mixed/text-search | 516.4ms | 734.2ms | 630.3ms |
| mixed/fibonacci | 477.0ms | 517.5ms | 472.0ms |
| mixed/matrix-multiply | 651.6ms | 711.0ms | 519.1ms |
| mixed/sieve | 598.7ms | 683.3ms | — |
