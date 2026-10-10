# js2wasm Benchmark Results

Date: 2026-10-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.050ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.109ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.412ms | 8.44ms | 2.80ms | FAILED | js |
| string/replace | 0.102ms | 0.700ms | 0.344ms | FAILED | js |
| string/case-convert | 0.056ms | 0.610ms | 0.277ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 4.14ms | 2.99ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.99ms | 3.25ms | 0.561ms | js |
| array/push-pop | 1.43ms | 0.503ms | 0.507ms | FAILED | host-call |
| array/sort-i32 | 0.800ms | 0.294ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.503ms | 0.510ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.042ms | 0.099ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.120ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.482ms | 8.75ms | 0.633ms | FAILED | js |
| mixed/text-search | 0.395ms | 5.13ms | 2.70ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 75.05ms | 77.18ms | 0.717ms | js |
| mixed/sieve | 1.56ms | 2.10ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.20 | 4.98 | 4.47 | — |
| string/concat-long | 1000 | 3.66 | 4.57 | 3.67 | — |
| string/indexOf | 1000 | 19.17 | 64.02 | 12.34 | 15.47 |
| string/includes | 1000 | 19.19 | 108.55 | 14.74 | 18.93 |
| string/split | 10000 | 41.20 | 843.88 | 279.65 | — |
| string/replace | 1000 | 101.54 | 700.47 | 343.86 | — |
| string/case-convert | 2000 | 27.84 | 304.85 | 138.40 | — |
| string/substring | 10000 | 9.89 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.14 | 413.53 | 298.95 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 149.41 | 162.54 | 28.03 |
| array/map-filter | 30000 | 4.25 | 2.35 | 2.34 | — |
| array/indexOf | 1000 | 3953.21 | 2644.09 | 2643.11 | — |
| dom/create-elements | 2000 | 20.82 | 49.66 | — | — |
| dom/set-attributes | 6000 | 17.63 | 36.14 | — | — |
| dom/read-attributes | 3000 | 19.00 | 39.90 | — | — |
| dom/modify-text | 2000 | 14.57 | 54.48 | — | — |
| mixed/csv-parse | 11000 | 43.85 | 795.12 | 57.59 | — |
| mixed/text-search | 40000 | 9.87 | 128.15 | 67.41 | 26.98 |
| mixed/fibonacci | 10000 | 12.01 | 28.32 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 600.42 | 617.44 | 5.74 |
| mixed/sieve | 200000 | 7.78 | 10.49 | 10.62 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.40x slower | — |
| string/concat-long | 1.25x slower | 1.00x slower | — |
| string/indexOf | 3.34x slower | 1.55x faster | 1.24x faster |
| string/includes | 5.66x slower | 1.30x faster | 1.01x faster |
| string/split | 20.48x slower | 6.79x slower | — |
| string/replace | 6.90x slower | 3.39x slower | — |
| string/case-convert | 10.95x slower | 4.97x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 24.13x slower | 17.44x slower | — |
| string/startsWith-endsWith | 7.46x slower | 8.11x slower | 1.40x slower |
| array/push-pop | 2.85x faster | 2.83x faster | — |
| array/sort-i32 | 2.72x faster | 2.73x faster | — |
| array/map-filter | 1.81x faster | 1.82x faster | — |
| array/reduce | 4.27x faster | 4.21x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.10x slower | 1.13x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 16.12x faster | 15.61x faster | 4.25x slower |
| dom/create-elements | 2.39x slower | — | — |
| dom/set-attributes | 2.05x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.74x slower | — | — |
| mixed/csv-parse | 18.13x slower | 1.31x slower | — |
| mixed/text-search | 12.98x slower | 6.83x slower | 2.73x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 475.68x slower | 489.16x slower | 4.54x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.19x faster |
| string/includes | 7.36x faster |
| string/split | 3.02x faster |
| string/replace | 2.04x faster |
| string/case-convert | 2.20x faster |
| string/substring | 1.22x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.09x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.03x slower |
| mixed/csv-parse | 13.81x faster |
| mixed/text-search | 1.90x faster |
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
| string/concat-short | 1155.2ms | 605.4ms | — |
| string/concat-long | 426.5ms | 638.0ms | — |
| string/indexOf | 362.8ms | 654.1ms | 542.2ms |
| string/includes | 368.0ms | 672.6ms | 563.8ms |
| string/split | 485.6ms | 700.2ms | — |
| string/replace | 485.0ms | 745.9ms | — |
| string/case-convert | 532.4ms | 592.6ms | — |
| string/substring | 396.8ms | 469.9ms | — |
| string/trim | 483.7ms | 687.4ms | — |
| string/startsWith-endsWith | 494.5ms | 690.5ms | 625.9ms |
| array/push-pop | 512.5ms | 590.4ms | — |
| array/sort-i32 | 676.8ms | 732.3ms | — |
| array/map-filter | 665.6ms | 729.7ms | — |
| array/reduce | 601.0ms | 684.1ms | — |
| array/indexOf | 594.4ms | 654.4ms | — |
| array/slice | 508.5ms | 602.2ms | — |
| array/reverse | 486.1ms | 570.0ms | — |
| array/forEach | 632.1ms | 683.7ms | — |
| array/find | 477.1ms | 574.3ms | 524.2ms |
| dom/create-elements | 423.8ms | — | — |
| dom/set-attributes | 367.2ms | — | — |
| dom/read-attributes | 380.0ms | — | — |
| dom/modify-text | 372.9ms | — | — |
| mixed/csv-parse | 528.0ms | 680.0ms | — |
| mixed/text-search | 514.8ms | 685.7ms | 619.1ms |
| mixed/fibonacci | 431.8ms | 498.9ms | 468.7ms |
| mixed/matrix-multiply | 660.8ms | 713.0ms | 526.3ms |
| mixed/sieve | 596.8ms | 657.8ms | — |
